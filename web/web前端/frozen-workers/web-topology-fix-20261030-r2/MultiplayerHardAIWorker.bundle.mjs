var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// application-hard:GameEngine.js
function topologyRootModeUnsupportedError() {
  const error = new Error("Topology boards currently support only classic root-v1 mode without initialRoots.");
  error.code = TOPOLOGY_ROOT_MODE_UNSUPPORTED;
  return error;
}
function getTopologyGameEngineFactory() {
  const factory = globalThis[TOPOLOGY_GAME_ENGINE_FACTORY];
  if (typeof factory !== "function") {
    throw new Error("Topology board support is unavailable. Load TopologyGameEngine.js before creating a topology board.");
  }
  return factory;
}
function resolveBoardShape(playerCount = 2, boardShape = null) {
  const shape = boardShape ?? (playerCount >= 4 ? "hexagon" : "triangle");
  if (!BOARD_SHAPES.includes(shape)) throw new Error("Unknown board shape.");
  return shape;
}
function getBoardVertices(gridSize, playerCount = 2, boardShape = null) {
  const r = gridSize - 1;
  const shape = resolveBoardShape(playerCount, boardShape);
  if (shape === "hexagon") return [[r, 0], [2 * r, 0], [2 * r, r], [r, 2 * r], [0, 2 * r], [0, r]];
  if (shape === "diamond") return [[0, 0], [r, 0], [r, r], [0, r]];
  return [[0, 0], [r, 0], [0, r]];
}
function isBoardPoint(point, gridSize, playerCount = 2, boardShape = null) {
  const x = point?.[0];
  const y = point?.[1];
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) return false;
  const r = gridSize - 1;
  const shape = resolveBoardShape(playerCount, boardShape);
  if (shape === "hexagon") return x <= 2 * r && y <= 2 * r && x + y >= r && x + y <= 3 * r;
  if (shape === "diamond") return x <= r && y <= r;
  return x + y <= r;
}
function getBoardPositions(gridSize, playerCount = 2, boardShape = null) {
  const extent = resolveBoardShape(playerCount, boardShape) === "hexagon" ? 2 * gridSize - 1 : gridSize;
  const positions = [];
  for (let y = 0; y < extent; y += 1) {
    for (let x = 0; x < extent; x += 1) {
      if (isBoardPoint([x, y], gridSize, playerCount, boardShape)) positions.push([x, y]);
    }
  }
  return positions;
}
function buildInitialPositions(gridSize, playerCount, boardShape = null) {
  if (playerCount > 6) throw new Error("7-15 players require random or custom starting points.");
  const shape = resolveBoardShape(playerCount, boardShape);
  if (shape === "diamond") {
    if (playerCount !== 2) throw new Error("Diamond boards with 3-15 players require random or custom starting points.");
    const r2 = gridSize - 1;
    return Object.freeze({
      [Player.BLACK]: Object.freeze([0, 0]),
      [Player.WHITE]: Object.freeze([r2, r2])
    });
  }
  if (shape === "hexagon") {
    const vertices = getBoardVertices(gridSize, playerCount, "hexagon");
    const occupiedVertices = playerCount === 2 ? [0, 3] : playerCount === 3 ? [0, 2, 4] : playerCount === 4 ? [0, 1, 3, 4] : [0, 1, 2, 3, 4, 5];
    return Object.freeze(Object.fromEntries(PLAYER_ORDER.slice(0, playerCount).map(
      (player, index) => [player, Object.freeze(vertices[occupiedVertices[index]])]
    )));
  }
  if (playerCount === 2) {
    return Object.freeze({
      [Player.BLACK]: Object.freeze([0, 0]),
      [Player.WHITE]: Object.freeze([gridSize - 1, 0])
    });
  }
  const r = gridSize - 1;
  const mid = Math.floor(r / 2);
  const seats = [[0, 0], [0, r], [r, 0], [0, mid], [mid, r - mid], [r - mid, 0]];
  return Object.freeze(Object.fromEntries(PLAYER_ORDER.slice(0, playerCount).map(
    (player, index) => [player, Object.freeze(seats[index])]
  )));
}
function resolveInitialPositions(gridSize, playerCount, positions = null, boardShape = null) {
  if (positions == null) return buildInitialPositions(gridSize, playerCount, boardShape);
  const players = PLAYER_ORDER.slice(0, playerCount);
  if (typeof positions !== "object" || Array.isArray(positions) || Object.keys(positions).length !== players.length) {
    throw new Error("Each player must have exactly one starting point.");
  }
  const occupied = /* @__PURE__ */ new Set();
  const result = {};
  for (const player of players) {
    const point = positions[player];
    if (!Array.isArray(point) || point.length !== 2 || !isBoardPoint(point, gridSize, playerCount, boardShape)) {
      throw new Error(`Invalid starting point for ${player}.`);
    }
    const key3 = pointKey(point);
    if (occupied.has(key3)) throw new Error("Starting points must not overlap.");
    occupied.add(key3);
    result[player] = Object.freeze(clonePoint(point));
  }
  return Object.freeze(result);
}
function areCollinearOnLattice(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx === 0 || dy === 0 || dx + dy === 0;
}
function latticeDistance(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dx + dy));
}
function buildDefaultDoubleRoots(gridSize, playerCount, boardShape = null) {
  if (playerCount !== 2) {
    throw new Error("Default fixed-double layouts are currently verified for two players only.");
  }
  const shape = resolveBoardShape(playerCount, boardShape);
  const primary = buildInitialPositions(gridSize, playerCount, shape);
  const [blackPrimary, whitePrimary] = [primary[Player.BLACK], primary[Player.WHITE]];
  const positions = getBoardPositions(gridSize, playerCount, shape);
  const radius = gridSize - 1;
  const mirror = shape === "triangle" ? ([x, y]) => [radius - x - y, y] : shape === "diamond" ? ([x, y]) => [radius - x, radius - y] : ([x, y]) => [2 * radius - x, 2 * radius - y];
  const candidates = [];
  for (const point of positions) {
    const other = mirror(point);
    if (!isBoardPoint(other, gridSize, playerCount, shape)) continue;
    if (areCollinearOnLattice(blackPrimary, point) || areCollinearOnLattice(whitePrimary, other)) continue;
    const all = [blackPrimary, point, whitePrimary, other];
    if (new Set(all.map(pointKey)).size !== all.length) continue;
    if ([blackPrimary, point].some((own3) => [whitePrimary, other].some((enemy) => latticeDistance(own3, enemy) <= 1))) continue;
    const ownDistance = Math.min(latticeDistance(blackPrimary, point), latticeDistance(whitePrimary, other));
    const enemyDistance = Math.min(...[blackPrimary, point].flatMap((own3) => [whitePrimary, other].map((enemy) => latticeDistance(own3, enemy))));
    candidates.push({ point, other, score: ownDistance * 100 + enemyDistance * 10 - Math.abs(point[1] - radius / 2) });
  }
  candidates.sort((a, b) => b.score - a.score || a.point[1] - b.point[1] || a.point[0] - b.point[0]);
  if (!candidates.length) throw new Error("No valid fixed-double layout exists for this board.");
  return {
    [Player.BLACK]: [clonePoint(blackPrimary), clonePoint(candidates[0].point)],
    [Player.WHITE]: [clonePoint(whitePrimary), clonePoint(candidates[0].other)]
  };
}
function resolveInitialRoots(gridSize, playerCount, roots = null, boardShape = null, rootMode = RootMode.CLASSIC, legacyPositions = null) {
  if (!SUPPORTED_ROOT_MODES.has(rootMode)) throw new Error(`Unsupported root mode: ${rootMode}`);
  const players = PLAYER_ORDER.slice(0, playerCount);
  const expectedCount = rootMode === RootMode.FIXED_DOUBLE ? 2 : 1;
  let source = roots;
  if (source == null) {
    if (rootMode === RootMode.FIXED_DOUBLE) source = buildDefaultDoubleRoots(gridSize, playerCount, boardShape);
    else {
      const positions = resolveInitialPositions(gridSize, playerCount, legacyPositions, boardShape);
      source = Object.fromEntries(players.map((player) => [player, [positions[player]]]));
    }
  }
  if (!source || typeof source !== "object" || Array.isArray(source) || Object.keys(source).length !== players.length) {
    throw new Error("Each player must have a complete root list.");
  }
  const occupied = /* @__PURE__ */ new Set();
  const normalized = {};
  for (const player of players) {
    const playerRoots = source[player];
    if (!Array.isArray(playerRoots) || playerRoots.length !== expectedCount) {
      throw new Error(`${player} must have exactly ${expectedCount} root${expectedCount === 1 ? "" : "s"}.`);
    }
    normalized[player] = playerRoots.map((point) => {
      if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isInteger) || !isBoardPoint(point, gridSize, playerCount, boardShape)) throw new Error(`Invalid root for ${player}.`);
      const key3 = pointKey(point);
      if (occupied.has(key3)) throw new Error("Roots must not overlap.");
      occupied.add(key3);
      return Object.freeze(clonePoint(point));
    });
    if (normalized[player].length === 2 && areCollinearOnLattice(normalized[player][0], normalized[player][1])) {
      throw new Error("A player's fixed roots must not be collinear.");
    }
  }
  if (rootMode !== RootMode.CLASSIC) {
    for (const player of players) {
      for (const root of normalized[player]) {
        for (const opponent of players) {
          if (opponent === player) continue;
          if (normalized[opponent].some((enemyRoot) => latticeDistance(root, enemyRoot) <= 1)) {
            throw new Error("Opponent roots must not enter each other's protection zones.");
          }
        }
      }
    }
  }
  return Object.freeze(Object.fromEntries(players.map((player) => [player, Object.freeze(normalized[player])])));
}
function clonePoint(point) {
  return [point[0], point[1]];
}
function cloneRootActions(value) {
  return Object.fromEntries(Object.entries(value).map(([player, quotas]) => [player, { ...quotas }]));
}
function pointKey(point) {
  return `${point[0]},${point[1]}`;
}
function keyToPoint(key3) {
  const [x, y] = key3.split(",").map(Number);
  return [x, y];
}
function pointEquals(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}
function applyBarycentricTransform(point, gridSize, permutation) {
  const barycentric = [point[0], point[1], gridSize - 1 - point[0] - point[1]];
  return [barycentric[permutation[0]], barycentric[permutation[1]]];
}
function applyDiamondTransform(point, gridSize, transform) {
  const r = gridSize - 1;
  switch (transform) {
    case DIAMOND_TRANSFORMS.IDENTITY:
      return [point[0], point[1]];
    case DIAMOND_TRANSFORMS.SWAP_XY:
      return [point[1], point[0]];
    case DIAMOND_TRANSFORMS.ROTATE_180:
      return [r - point[0], r - point[1]];
    case DIAMOND_TRANSFORMS.SWAP_ANTI_DIAGONAL:
      return [r - point[1], r - point[0]];
    default:
      throw new Error("Unknown diamond transform.");
  }
}
function applyHexTransform(point, gridSize, transform, inverse = false) {
  const r = gridSize - 1;
  let x = point[0] - r;
  let y = point[1] - r;
  if (inverse && transform.reflected) [x, y] = [-x, x + y];
  const rotations = ((inverse ? -transform.rotation : transform.rotation) % 6 + 6) % 6;
  for (let index = 0; index < rotations; index += 1) [x, y] = [-y, x + y];
  if (!inverse && transform.reflected) [x, y] = [-x, x + y];
  return [x + r, y + r];
}
function invertPermutation(permutation) {
  const inverse = new Array(permutation.length);
  for (let index = 0; index < permutation.length; index += 1) {
    inverse[permutation[index]] = index;
  }
  return inverse;
}
function canonicalPolygonKey(polygon) {
  if (!polygon?.length) return "";
  const openPolygon = polygon.length > 1 && pointEquals(polygon[0], polygon[polygon.length - 1]) ? polygon.slice(0, -1) : polygon;
  if (!openPolygon.length) return "";
  const representations = [];
  for (const oriented of [openPolygon, [...openPolygon].reverse()]) {
    for (let offset = 0; offset < oriented.length; offset += 1) {
      representations.push(
        [...oriented.slice(offset), ...oriented.slice(0, offset)].map(pointKey).join("|")
      );
    }
  }
  representations.sort();
  return representations[0];
}
function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}
function dedupePoints(points) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const point of points) {
    const key3 = pointKey(point);
    if (!seen.has(key3)) {
      seen.add(key3);
      result.push(clonePoint(point));
    }
  }
  return result;
}
function computeTriangularPolygonArea(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) {
    return 0;
  }
  let area = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    area += current[0] * next[1] - next[0] * current[1];
  }
  return Math.abs(area);
}
function dependencyBucket(maxCharacters, maxUnits) {
  return { entries: /* @__PURE__ */ new Map(), characters: 0, units: 0, maxCharacters, maxUnits };
}
function dependencyMemo(engine) {
  if (!TERRITORY_DEPENDENCY_MEMOS.has(engine)) TERRITORY_DEPENDENCY_MEMOS.set(engine, {
    geometry: null,
    context: null,
    raw: dependencyBucket(131072, 16384),
    bfs: dependencyBfsBucket(),
    stats: { rawHits: 0, rawMisses: 0, bfsExactHits: 0, bfsDependencyHits: 0, bfsMisses: 0, geometryChanges: 0 }
  });
  return TERRITORY_DEPENDENCY_MEMOS.get(engine);
}
function updateDependencyGeometry(engine, memo) {
  const geometry2 = JSON.stringify([
    engine.gridSize,
    engine.boardShape,
    engine.validPositions,
    engine._adjIdxList,
    engine._boundaryIdxs,
    [...engine._keyToIdx],
    engine._rowIndexOffsets,
    engine._rowIndexGridSize,
    engine._rowIndexBoardShape,
    engine._wallKeyWordCount
  ]);
  if (geometry2 !== memo.geometry) {
    if (memo.geometry !== null) memo.stats.geometryChanges++;
    memo.geometry = geometry2;
    memo.raw = dependencyBucket(131072, 16384);
    memo.bfs = dependencyBfsBucket();
  }
}
function dependencyGet(bucket, key3) {
  const record = bucket.entries.get(key3);
  if (!record) return null;
  bucket.entries.delete(key3);
  bucket.entries.set(key3, record);
  return record.value;
}
function dependencyPut(bucket, key3, value, units) {
  if (key3.length > bucket.maxCharacters || units > bucket.maxUnits) return;
  while (bucket.entries.size >= 64 || bucket.characters + key3.length > bucket.maxCharacters || bucket.units + units > bucket.maxUnits) {
    const [oldKey, record] = bucket.entries.entries().next().value;
    bucket.entries.delete(oldKey);
    bucket.characters -= oldKey.length;
    bucket.units -= record.units;
  }
  bucket.entries.set(key3, { value, units });
  bucket.characters += key3.length;
  bucket.units += units;
}
function dependencyPointsKey(points) {
  if (!Array.isArray(points) || Object.getPrototypeOf(points) !== Array.prototype || points.length > 4096 || points.map !== Array.prototype.map || points[Symbol.iterator] !== Array.prototype[Symbol.iterator]) return null;
  const parts = [];
  for (let index = 0; index < points.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(points, String(index));
    if (!descriptor || !("value" in descriptor)) return null;
    const point = descriptor.value;
    if (!Array.isArray(point) || point.length !== 2) return null;
    const x = Object.getOwnPropertyDescriptor(point, "0"), y = Object.getOwnPropertyDescriptor(point, "1");
    if (!x || !y || !("value" in x) || !("value" in y) || !Number.isSafeInteger(x.value) || !Number.isSafeInteger(y.value) || Object.is(x.value, -0) || Object.is(y.value, -0)) return null;
    parts.push(`${x.value},${y.value}`);
  }
  return parts.join(";");
}
function copyDependencyTerritory(result) {
  return {
    ...result,
    polygon: result.polygon ? result.polygon.map(clonePoint) : null,
    ...Array.isArray(result.renderPoints) ? { renderPoints: result.renderPoints.map(clonePoint) } : {}
  };
}
function dependencyBfsBucket() {
  return { groups: /* @__PURE__ */ new Map(), entries: 0, characters: 0, units: 0 };
}
function dependencyBfsGet(bucket, obstacleKey, srcIdx) {
  const group = bucket.groups.get(obstacleKey);
  if (!group) return null;
  bucket.groups.delete(obstacleKey);
  bucket.groups.set(obstacleKey, group);
  return group.entries.get(srcIdx) || null;
}
function dependencyBfsPut(bucket, obstacleKey, srcIdx, entry) {
  if (obstacleKey.length > 65536 || entry.units > 524288) return;
  let group = bucket.groups.get(obstacleKey);
  if (group?.entries.has(srcIdx) || group && group.entries.size >= 6) return;
  while (!group && bucket.groups.size >= 12 || bucket.characters + (group ? 0 : obstacleKey.length) > 65536 || bucket.units + entry.units > 524288) {
    const [key3, removed] = bucket.groups.entries().next().value;
    bucket.groups.delete(key3);
    bucket.characters -= key3.length;
    bucket.entries -= removed.entries.size;
    bucket.units -= removed.units;
    if (key3 === obstacleKey) group = null;
  }
  if (!group) {
    group = { entries: /* @__PURE__ */ new Map(), units: 0 };
    bucket.groups.set(obstacleKey, group);
    bucket.characters += obstacleKey.length;
  }
  group.entries.set(srcIdx, entry);
  group.units += entry.units;
  bucket.entries++;
  bucket.units += entry.units;
}
function packDependencyBfs(result) {
  const offsets = new Int32Array(result.pred.length + 1);
  for (let index = 0; index < result.pred.length; index++) offsets[index + 1] = offsets[index] + (result.pred[index]?.length || 0);
  const predecessors = new Int32Array(offsets[offsets.length - 1]);
  for (let index = 0; index < result.pred.length; index++) if (result.pred[index]) predecessors.set(result.pred[index], offsets[index]);
  return { dist: new Int32Array(result.dist), offsets, predecessors };
}
function unpackDependencyBfs(result) {
  return { dist: new Int32Array(result.dist), pred: Array.from({ length: result.dist.length }, (_, index) => result.offsets[index + 1] > result.offsets[index] ? Array.from(result.predecessors.subarray(result.offsets[index], result.offsets[index + 1])) : null) };
}
var DEFAULT_GRID_SIZE, TOPOLOGY_GAME_ENGINE_FACTORY, TOPOLOGY_ROOT_MODE_UNSUPPORTED, MIN_GRID_SIZE, MAX_GRID_SIZE, TerritoryRulesVersion, RootRulesVersion, RootMode, SUPPORTED_ROOT_MODES, SUPPORTED_ROOT_RULES, TopologyRulesVersion, SUPPORTED_TERRITORY_RULES, BOARD_SHAPES, StartProtectionRule, SUPPORTED_START_PROTECTION_RULES, BARYCENTRIC_TRANSFORMS, DIAMOND_TRANSFORMS, Player, PointState, PLAYER_ORDER, DIRECTIONS, DIRS_CW, PLAYER_POINT_STATES, GameEngine, NATIVE_TERRITORY_METHODS, NATIVE_SHARED_TERRITORY_METHODS, NATIVE_FLOOD_COVERAGE, NATIVE_FLOOD_POINT_INDEX, TERRITORY_DEPENDENCY_MEMOS, NATIVE_DEPENDENCY_METHODS, GameEngine_default;
var init_GameEngine = __esm({
  "application-hard:GameEngine.js"() {
    DEFAULT_GRID_SIZE = 9;
    TOPOLOGY_GAME_ENGINE_FACTORY = Symbol.for("lifeline.topology-game-engine-factory.v1");
    TOPOLOGY_ROOT_MODE_UNSUPPORTED = "TOPOLOGY_ROOT_MODE_UNSUPPORTED";
    __name(topologyRootModeUnsupportedError, "topologyRootModeUnsupportedError");
    __name(getTopologyGameEngineFactory, "getTopologyGameEngineFactory");
    MIN_GRID_SIZE = 5;
    MAX_GRID_SIZE = 15;
    TerritoryRulesVersion = Object.freeze({
      V1: "territory-v1",
      V2: "territory-v2",
      V3: "territory-v3"
    });
    RootRulesVersion = Object.freeze({
      V1: "root-v1",
      V2: "root-v2"
    });
    RootMode = Object.freeze({
      CLASSIC: "classic",
      FIXED_DOUBLE: "fixed-double",
      RELOCATE: "relocate",
      ADD: "add"
    });
    SUPPORTED_ROOT_MODES = new Set(Object.values(RootMode));
    SUPPORTED_ROOT_RULES = new Set(Object.values(RootRulesVersion));
    TopologyRulesVersion = Object.freeze({
      SURFACE_V1: "surface-v1"
    });
    SUPPORTED_TERRITORY_RULES = new Set(Object.values(TerritoryRulesVersion));
    BOARD_SHAPES = Object.freeze(["triangle", "diamond", "hexagon"]);
    StartProtectionRule = Object.freeze({
      SYMMETRIC: "symmetric-v1",
      DUEL_FIRST_UNPROTECTED: "duel-first-unprotected-v1"
    });
    SUPPORTED_START_PROTECTION_RULES = new Set(Object.values(StartProtectionRule));
    BARYCENTRIC_TRANSFORMS = Object.freeze({
      IDENTITY: Object.freeze([0, 1, 2]),
      SWAP_XY: Object.freeze([1, 0, 2]),
      SWAP_YZ: Object.freeze([0, 2, 1]),
      SWAP_XZ: Object.freeze([2, 1, 0]),
      CYCLE_XYZ: Object.freeze([1, 2, 0]),
      CYCLE_XZY: Object.freeze([2, 0, 1])
    });
    DIAMOND_TRANSFORMS = Object.freeze({
      IDENTITY: "identity",
      SWAP_XY: "swap-xy",
      ROTATE_180: "rotate-180",
      SWAP_ANTI_DIAGONAL: "swap-anti-diagonal"
    });
    Player = Object.freeze({
      BLACK: "BLACK",
      WHITE: "WHITE",
      PURPLE: "PURPLE",
      GREEN: "GREEN",
      ORANGE: "ORANGE",
      CYAN: "CYAN",
      PINK: "PINK",
      BROWN: "BROWN",
      LIME: "LIME",
      NAVY: "NAVY",
      GOLD: "GOLD",
      TEAL: "TEAL",
      MAGENTA: "MAGENTA",
      SLATE: "SLATE",
      CORAL: "CORAL"
    });
    PointState = Object.freeze({
      EMPTY: 0,
      BLACK_NODE: 1,
      BLACK_LINE: 2,
      WHITE_NODE: 3,
      WHITE_LINE: 4,
      PURPLE_NODE: 5,
      PURPLE_LINE: 6,
      GREEN_NODE: 7,
      GREEN_LINE: 8,
      ORANGE_NODE: 9,
      ORANGE_LINE: 10,
      CYAN_NODE: 11,
      CYAN_LINE: 12,
      PINK_NODE: 13,
      PINK_LINE: 14,
      BROWN_NODE: 15,
      BROWN_LINE: 16,
      LIME_NODE: 17,
      LIME_LINE: 18,
      NAVY_NODE: 19,
      NAVY_LINE: 20,
      GOLD_NODE: 21,
      GOLD_LINE: 22,
      TEAL_NODE: 23,
      TEAL_LINE: 24,
      MAGENTA_NODE: 25,
      MAGENTA_LINE: 26,
      SLATE_NODE: 27,
      SLATE_LINE: 28,
      CORAL_NODE: 29,
      CORAL_LINE: 30
    });
    PLAYER_ORDER = Object.freeze([
      Player.BLACK,
      Player.WHITE,
      Player.PURPLE,
      Player.GREEN,
      Player.ORANGE,
      Player.CYAN,
      Player.PINK,
      Player.BROWN,
      Player.LIME,
      Player.NAVY,
      Player.GOLD,
      Player.TEAL,
      Player.MAGENTA,
      Player.SLATE,
      Player.CORAL
    ]);
    DIRECTIONS = Object.freeze([
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, -1],
      [-1, 1]
    ]);
    DIRS_CW = Object.freeze([[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]]);
    PLAYER_POINT_STATES = Object.freeze({
      ...Object.fromEntries(PLAYER_ORDER.map((player) => [player, Object.freeze({
        node: PointState[`${player}_NODE`],
        line: PointState[`${player}_LINE`]
      })])),
      [Player.BLACK]: Object.freeze({
        node: PointState.BLACK_NODE,
        line: PointState.BLACK_LINE
      }),
      [Player.WHITE]: Object.freeze({
        node: PointState.WHITE_NODE,
        line: PointState.WHITE_LINE
      }),
      [Player.PURPLE]: Object.freeze({
        node: PointState.PURPLE_NODE,
        line: PointState.PURPLE_LINE
      }),
      [Player.GREEN]: Object.freeze({
        node: PointState.GREEN_NODE,
        line: PointState.GREEN_LINE
      }),
      [Player.ORANGE]: Object.freeze({
        node: PointState.ORANGE_NODE,
        line: PointState.ORANGE_LINE
      }),
      [Player.CYAN]: Object.freeze({
        node: PointState.CYAN_NODE,
        line: PointState.CYAN_LINE
      })
    });
    __name(resolveBoardShape, "resolveBoardShape");
    __name(getBoardVertices, "getBoardVertices");
    __name(isBoardPoint, "isBoardPoint");
    __name(getBoardPositions, "getBoardPositions");
    __name(buildInitialPositions, "buildInitialPositions");
    __name(resolveInitialPositions, "resolveInitialPositions");
    __name(areCollinearOnLattice, "areCollinearOnLattice");
    __name(latticeDistance, "latticeDistance");
    __name(buildDefaultDoubleRoots, "buildDefaultDoubleRoots");
    __name(resolveInitialRoots, "resolveInitialRoots");
    __name(clonePoint, "clonePoint");
    __name(cloneRootActions, "cloneRootActions");
    __name(pointKey, "pointKey");
    __name(keyToPoint, "keyToPoint");
    __name(pointEquals, "pointEquals");
    __name(applyBarycentricTransform, "applyBarycentricTransform");
    __name(applyDiamondTransform, "applyDiamondTransform");
    __name(applyHexTransform, "applyHexTransform");
    __name(invertPermutation, "invertPermutation");
    __name(canonicalPolygonKey, "canonicalPolygonKey");
    __name(cross, "cross");
    __name(dedupePoints, "dedupePoints");
    __name(computeTriangularPolygonArea, "computeTriangularPolygonArea");
    GameEngine = class _GameEngine {
      static {
        __name(this, "GameEngine");
      }
      constructor(options = {}) {
        if (options.boardDefinition || options.compiledBoard) {
          const rootMode = options.rootMode ?? RootMode.CLASSIC;
          const rootRulesVersion = options.rootRulesVersion ?? (rootMode === RootMode.CLASSIC ? RootRulesVersion.V1 : RootRulesVersion.V2);
          if (rootMode !== RootMode.CLASSIC || rootRulesVersion !== RootRulesVersion.V1 || Object.hasOwn(options, "initialRoots")) {
            throw topologyRootModeUnsupportedError();
          }
          return getTopologyGameEngineFactory()(options, {
            basePrototype: _GameEngine.prototype,
            playerOrder: PLAYER_ORDER,
            pointState: PointState,
            playerPointStates: PLAYER_POINT_STATES,
            surfaceRulesVersion: TopologyRulesVersion.SURFACE_V1
          });
        }
        this.gridSize = options.gridSize ?? DEFAULT_GRID_SIZE;
        if (!Number.isInteger(this.gridSize) || this.gridSize < MIN_GRID_SIZE || this.gridSize > MAX_GRID_SIZE) {
          throw new Error(`gridSize must be an integer between ${MIN_GRID_SIZE} and ${MAX_GRID_SIZE}.`);
        }
        const rulesVersion = options.rulesVersion ?? TerritoryRulesVersion.V1;
        if (!SUPPORTED_TERRITORY_RULES.has(rulesVersion)) {
          throw new Error(`Unsupported territory rules version: ${rulesVersion}`);
        }
        Object.defineProperty(this, "rulesVersion", {
          value: rulesVersion,
          enumerable: true,
          writable: false,
          configurable: false
        });
        const protectionRule = options.protectionRule ?? StartProtectionRule.SYMMETRIC;
        if (!SUPPORTED_START_PROTECTION_RULES.has(protectionRule)) {
          throw new Error(`Unsupported start protection rule: ${protectionRule}`);
        }
        Object.defineProperty(this, "protectionRule", {
          value: protectionRule,
          enumerable: true,
          writable: false,
          configurable: false
        });
        this.playerCount = options.playerCount ?? 2;
        if (!Number.isInteger(this.playerCount) || this.playerCount < 2 || this.playerCount > 15) {
          throw new Error("playerCount must be an integer between 2 and 15.");
        }
        this.boardShape = resolveBoardShape(this.playerCount, options.boardShape);
        this.boardVertices = getBoardVertices(this.gridSize, this.playerCount, this.boardShape);
        this.activePlayers = PLAYER_ORDER.slice(0, this.playerCount);
        this.rootMode = options.rootMode ?? RootMode.CLASSIC;
        if (!SUPPORTED_ROOT_MODES.has(this.rootMode)) throw new Error(`Unsupported root mode: ${this.rootMode}`);
        this.rootRulesVersion = options.rootRulesVersion ?? (this.rootMode === RootMode.CLASSIC ? RootRulesVersion.V1 : RootRulesVersion.V2);
        if (!SUPPORTED_ROOT_RULES.has(this.rootRulesVersion) || this.rootMode === RootMode.CLASSIC !== (this.rootRulesVersion === RootRulesVersion.V1)) {
          throw new Error("Root mode and root rules version are incompatible.");
        }
        if (this.rootRulesVersion === RootRulesVersion.V2 && rulesVersion !== TerritoryRulesVersion.V3) {
          throw new Error("Multi-root modes require territory-v3 scoring.");
        }
        this.hasCustomInitialPositions = options.initialPositions != null;
        this.hasCustomInitialRoots = options.initialRoots != null;
        this.initialRoots = resolveInitialRoots(
          this.gridSize,
          this.playerCount,
          options.initialRoots,
          this.boardShape,
          this.rootMode,
          options.initialPositions
        );
        this.initialPositions = Object.freeze(Object.fromEntries(this.activePlayers.map((player) => [
          player,
          Object.freeze(clonePoint(this.initialRoots[player][0]))
        ])));
        this.roots = Object.fromEntries(this.activePlayers.map((player) => [
          player,
          this.initialRoots[player].map(clonePoint)
        ]));
        this.rootActionsRemaining = Object.fromEntries(this.activePlayers.map((player) => [player, {
          relocate: this.rootMode === RootMode.RELOCATE ? 1 : 0,
          add: this.rootMode === RootMode.ADD ? 1 : 0
        }]));
        this.startPlayer = this.activePlayers.includes(options.startPlayer) ? options.startPlayer : this.activePlayers[0];
        this.validPositions = [];
        this.positionKeys = /* @__PURE__ */ new Set();
        this.grid = /* @__PURE__ */ new Map();
        this.currentPlayer = this.startPlayer;
        this.gameOver = false;
        this.consecutiveSkips = 0;
        this.resignedPlayers = /* @__PURE__ */ new Set();
        this.turnCount = 0;
        this.positionRevision = 0;
        this.deferTerritoryUpdates = Boolean(options.deferTerritoryUpdates);
        this._territoryStateRevision = 0;
        this._territoryCacheRevision = 0;
        this._isReplayingBatch = false;
        this.cachedTerritories = Object.fromEntries(
          this.activePlayers.map((player) => [player, {
            polygon: null,
            area: 0,
            displayArea: 0,
            ...this.rulesVersion === TerritoryRulesVersion.V3 ? { renderPoints: [] } : {}
          }])
        );
        this.edges = Object.fromEntries(this.activePlayers.map((player) => [player, /* @__PURE__ */ new Set()]));
        this.historyHashes = /* @__PURE__ */ new Set();
        this._initGrid();
        for (const player of this.activePlayers) {
          for (const root of this.roots[player]) this._setState(root, this._getPlayerStates(player).node);
        }
        if (this.rulesVersion === TerritoryRulesVersion.V3) {
          for (const player of this.activePlayers) {
            this.cachedTerritories[player] = {
              polygon: null,
              area: this.roots[player].length,
              displayArea: this.roots[player].length,
              renderPoints: this.roots[player].map(clonePoint)
            };
          }
        }
        this.historyHashes.add(this._computeStateHash(this.startPlayer));
      }
      _initGrid() {
        this._keyToIdx = /* @__PURE__ */ new Map();
        this._rowIndexOffsets = [];
        this._rowIndexGridSize = this.gridSize;
        this._rowIndexBoardShape = this.boardShape;
        for (const point of getBoardPositions(this.gridSize, this.playerCount, this.boardShape)) {
          const key3 = pointKey(point);
          const idx = this.validPositions.length;
          this.validPositions.push(point);
          this.positionKeys.add(key3);
          this.grid.set(key3, PointState.EMPTY);
          this._keyToIdx.set(key3, idx);
          this._rowIndexOffsets[point[1]] ??= idx - point[0];
        }
        const n = this.validPositions.length;
        this._adjIdxList = new Array(n);
        for (let i = 0; i < n; i += 1) {
          const [x, y] = this.validPositions[i];
          const adj = [];
          for (const [dx, dy] of DIRECTIONS) {
            const k = `${x + dx},${y + dy}`;
            const ni = this._keyToIdx.get(k);
            if (ni !== void 0) adj.push(ni);
          }
          this._adjIdxList[i] = adj;
        }
        this._boundaryIdxs = [];
        for (let i = 0; i < n; i += 1) {
          if (this._adjIdxList[i].length < DIRECTIONS.length) {
            this._boundaryIdxs.push(i);
          }
        }
        this._bfsQueue = new Int32Array(n);
        this._bfsWall = new Int32Array(n);
        this._bfsWater = new Int32Array(n);
        this._bfsRequired = new Int32Array(n);
        this._bfsEpoch = 0;
        this._wallKeyWordCount = Math.ceil(n / 32);
      }
      _pointToIndex(point) {
        const x = point?.[0];
        const y = point?.[1];
        if (this.boardShape === "hexagon") {
          const radius = this.gridSize - 1;
          return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x <= 2 * radius && y <= 2 * radius && x + y >= radius && x + y <= 3 * radius ? this._rowIndexGridSize === this.gridSize && this._rowIndexBoardShape === this.boardShape ? this._rowIndexOffsets[y] + x : this._keyToIdx.get(pointKey(point)) ?? -1 : -1;
        }
        if (this.boardShape === "diamond") {
          const radius = this.gridSize - 1;
          return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x <= radius && y <= radius ? y * this.gridSize + x : -1;
        }
        if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x + y >= this.gridSize) {
          return -1;
        }
        return y * this.gridSize - y * (y - 1) / 2 + x;
      }
      _getWallSetKey(polygon) {
        const words = new Uint32Array(this._wallKeyWordCount);
        for (const point of polygon) {
          const index = this._pointToIndex(point);
          if (index < 0) return null;
          words[index >>> 5] |= 1 << (index & 31);
        }
        return words.join(",");
      }
      _assertValidPosition(point) {
        if (!this.isValidPosition(point)) {
          throw new Error(`Invalid grid position: ${JSON.stringify(point)}`);
        }
      }
      isValidPosition(point) {
        return this.positionKeys.has(pointKey(point));
      }
      _getState(point) {
        return this.grid.get(pointKey(point));
      }
      _setState(point, state) {
        const key3 = pointKey(point);
        if (this._moveProbeUndo && !this._moveProbeUndo.has(key3)) {
          this._moveProbeUndo.set(key3, this.grid.get(key3));
        }
        this.grid.set(key3, state);
      }
      _getPlayerStates(player) {
        return PLAYER_POINT_STATES[player];
      }
      _getOpponents(player) {
        return this.activePlayers.filter((candidate) => candidate !== player);
      }
      _getPlayerByLineState(lineState) {
        return this.activePlayers.find((player) => this._getPlayerStates(player).line === lineState) ?? null;
      }
      _getInitialPosition(player) {
        return clonePoint(this.initialPositions[player]);
      }
      _getRoots(player) {
        return this.roots[player] ?? [];
      }
      getRoots(player) {
        if (!this.activePlayers.includes(player)) return [];
        return this._getRoots(player).map(clonePoint);
      }
      getCurrentPlayer() {
        return this.currentPlayer;
      }
      getValidPositions() {
        return this.validPositions.map(clonePoint);
      }
      getStateAt(point) {
        if (!this.isValidPosition(point)) {
          return null;
        }
        return this._getState(point);
      }
      getBoardMatrix() {
        const matrix = [];
        const extent = this.boardShape === "hexagon" ? 2 * this.gridSize - 1 : this.gridSize;
        for (let y = 0; y < extent; y += 1) {
          const row = [];
          for (let x = 0; x < extent; x += 1) {
            row.push(this.isValidPosition([x, y]) ? this._getState([x, y]) : null);
          }
          matrix.push(row);
        }
        return matrix;
      }
      getScoreboard() {
        return Object.fromEntries(
          this.activePlayers.map((player) => {
            const territory = this.cachedTerritories[player];
            return [player, {
              ...territory,
              polygon: territory.polygon ? territory.polygon.map(clonePoint) : null,
              ...Array.isArray(territory.renderPoints) ? { renderPoints: territory.renderPoints.map(clonePoint) } : {}
            }];
          })
        );
      }
      getSnapshot() {
        const winner = this.getWinner();
        const territoryPending = this.hasPendingTerritoryUpdate();
        const scores = this.getScoreboard();
        const territories = Object.fromEntries(
          this.activePlayers.map((player) => [
            player,
            {
              area: scores[player].area,
              displayArea: scores[player].displayArea ?? scores[player].area,
              polygon: scores[player].polygon ? scores[player].polygon.map(clonePoint) : null,
              ...Array.isArray(scores[player].renderPoints) ? { renderPoints: scores[player].renderPoints.map(clonePoint) } : {}
            }
          ])
        );
        const edges = Object.fromEntries(
          PLAYER_ORDER.slice(0, Math.max(3, this.playerCount)).map((player) => [
            player,
            this.activePlayers.includes(player) ? [...this._getEdges(player)] : []
          ])
        );
        return {
          gridSize: this.gridSize,
          playerCount: this.playerCount,
          boardShape: this.boardShape,
          boardVertices: this.boardVertices.map(clonePoint),
          initialPositions: Object.fromEntries(this.activePlayers.map((player) => [player, this._getInitialPosition(player)])),
          initialRoots: Object.fromEntries(this.activePlayers.map((player) => [player, this.initialRoots[player].map(clonePoint)])),
          roots: Object.fromEntries(this.activePlayers.map((player) => [player, this.getRoots(player)])),
          rootMode: this.rootMode,
          rootRulesVersion: this.rootRulesVersion,
          rootActionsRemaining: cloneRootActions(this.rootActionsRemaining),
          rulesVersion: this.rulesVersion,
          ...this.protectionRule !== StartProtectionRule.SYMMETRIC ? { protectionRule: this.protectionRule } : {},
          positionRevision: this.positionRevision,
          players: [...this.activePlayers],
          startPlayer: this.startPlayer,
          currentPlayer: this.currentPlayer,
          gameOver: this.gameOver,
          territoryPending,
          consecutiveSkips: this.consecutiveSkips,
          resignedPlayers: [...this.resignedPlayers],
          turnCount: this.turnCount,
          boardMatrix: this.getBoardMatrix(),
          territories,
          edges,
          winner,
          legalMoves: this._getSnapshotLegalMoves(),
          legalRootActions: this.getLegalRootActions()
        };
      }
      _getSnapshotLegalMoves() {
        const key3 = JSON.stringify([
          this.gridSize,
          this.boardShape,
          this.rulesVersion,
          this.activePlayers,
          this.positionRevision,
          this.startPlayer,
          this.turnCount,
          this.gameOver,
          this.consecutiveSkips,
          this.currentPlayer,
          this.initialPositions,
          this.initialRoots,
          this.roots,
          this.rootMode,
          this.rootRulesVersion,
          this.rootActionsRemaining,
          this.validPositions,
          [...this.positionKeys],
          [...this.grid],
          this.activePlayers.map((player) => [...this._getEdges(player)]),
          [...this.historyHashes],
          [...this.resignedPlayers]
        ]);
        if (this._snapshotLegalCache?.key !== key3) {
          this._snapshotLegalCache = { key: key3, moves: this.getLegalMoves(this.currentPlayer) };
        }
        return this._snapshotLegalCache.moves.map((move) => ({ ...move, point: clonePoint(move.point) }));
      }
      /** Whether the cached display territory belongs to the current board.
       *  Skip/resign actions do not change the board and therefore intentionally
       *  leave this status unchanged. */
      hasPendingTerritoryUpdate() {
        return this._territoryCacheRevision !== this._territoryStateRevision;
      }
      getTerritoryStateRevision() {
        return this._territoryStateRevision;
      }
      /** Apply an exact territory cache calculated from an isolated Worker.
       *  The revision check prevents a late result from painting a newer board. */
      applyTerritoryCache(territories, territoryStateRevision = this._territoryStateRevision) {
        if (territoryStateRevision !== this._territoryStateRevision || !territories) {
          return false;
        }
        const nextTerritories = {};
        for (const player of this.activePlayers) {
          const territory = territories[player];
          if (!territory || !Number.isInteger(territory.area) || territory.area < 0) {
            return false;
          }
          if (!Number.isFinite(territory.displayArea)) {
            return false;
          }
          let polygon = null;
          if (territory.polygon !== null) {
            if (!Array.isArray(territory.polygon) || territory.polygon.length < 3) {
              return false;
            }
            polygon = [];
            for (const point of territory.polygon) {
              if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isInteger) || !this.isValidPosition(point)) {
                return false;
              }
              polygon.push(clonePoint(point));
            }
          }
          let renderPoints;
          if (territory.renderPoints !== void 0) {
            if (!Array.isArray(territory.renderPoints) || territory.renderPoints.length > this.validPositions.length) {
              return false;
            }
            const keys = /* @__PURE__ */ new Set();
            renderPoints = [];
            for (const point of territory.renderPoints) {
              if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isInteger) || !this.isValidPosition(point)) {
                return false;
              }
              const key3 = pointKey(point);
              if (keys.has(key3)) return false;
              keys.add(key3);
              renderPoints.push(clonePoint(point));
            }
          }
          if (this.rulesVersion === TerritoryRulesVersion.V3 && (!renderPoints || renderPoints.length !== territory.area)) {
            return false;
          }
          nextTerritories[player] = {
            polygon,
            area: territory.area,
            displayArea: territory.displayArea,
            ...renderPoints ? { renderPoints } : {}
          };
        }
        this.cachedTerritories = nextTerritories;
        this._territoryCacheRevision = this._territoryStateRevision;
        return true;
      }
      getWinner() {
        if (!this.gameOver) {
          return null;
        }
        if (this.hasPendingTerritoryUpdate()) {
          this._updateTerritories();
        }
        let winner = null;
        let bestArea = Number.NEGATIVE_INFINITY;
        let isDraw = false;
        const scoringPlayers = this.activePlayers.filter((player) => !this.resignedPlayers.has(player));
        const candidatePlayers = scoringPlayers.length ? scoringPlayers : this.activePlayers;
        for (const player of candidatePlayers) {
          const area = this.cachedTerritories[player].area;
          if (area > bestArea) {
            bestArea = area;
            winner = player;
            isDraw = false;
          } else if (area === bestArea) {
            isDraw = true;
          }
        }
        return isDraw ? "DRAW" : winner;
      }
      _getPlayerNodes(player) {
        const nodeState = this._getPlayerStates(player).node;
        return this.validPositions.filter((point) => this._getState(point) === nodeState).map(clonePoint);
      }
      _getPlayerLines(player) {
        const lineState = this._getPlayerStates(player).line;
        return this.validPositions.filter((point) => this._getState(point) === lineState).map(clonePoint);
      }
      getAdjacentPositions(point) {
        const [x, y] = point;
        return DIRECTIONS.map(([dx, dy]) => [x + dx, y + dy]).filter((nextPoint) => this.isValidPosition(nextPoint));
      }
      canConnect(pointA, pointB) {
        const [x1, y1] = pointA;
        const [x2, y2] = pointB;
        return x1 === x2 || y1 === y2 || x1 + y1 === x2 + y2;
      }
      getLinePoints(start, end) {
        if (!this.canConnect(start, end)) {
          return [];
        }
        const [x1, y1] = start;
        const [x2, y2] = end;
        const points = [];
        if (x1 === x2) {
          const minY = Math.min(y1, y2);
          const maxY = Math.max(y1, y2);
          for (let y = minY; y <= maxY; y += 1) {
            const point = [x1, y];
            if (this.isValidPosition(point)) {
              points.push(point);
            }
          }
          return points;
        }
        if (y1 === y2) {
          const minX = Math.min(x1, x2);
          const maxX = Math.max(x1, x2);
          for (let x = minX; x <= maxX; x += 1) {
            const point = [x, y1];
            if (this.isValidPosition(point)) {
              points.push(point);
            }
          }
          return points;
        }
        const left = x1 < x2 ? [x1, y1] : [x2, y2];
        const right = x1 < x2 ? [x2, y2] : [x1, y1];
        const length = right[0] - left[0];
        for (let i = 0; i <= length; i += 1) {
          const point = [left[0] + i, left[1] - i];
          if (this.isValidPosition(point)) {
            points.push(point);
          }
        }
        return points;
      }
      canConnectWithBlocking(pointA, pointB, player) {
        if (!this.canConnect(pointA, pointB)) {
          return false;
        }
        const linePoints = this.getLinePoints(pointA, pointB);
        const opponentStates = this._getOpponents(player).map((opponent) => this._getPlayerStates(opponent));
        for (const point of linePoints) {
          if (pointEquals(point, pointA) || pointEquals(point, pointB)) {
            continue;
          }
          const state = this._getState(point);
          for (const states of opponentStates) {
            if (state === states.node || state === states.line) {
              return false;
            }
          }
        }
        return true;
      }
      _checkThreePointLimitation(newPoint, player) {
        const nodeState = this._getPlayerStates(player).node;
        const adjacentNodes = this.getAdjacentPositions(newPoint).filter((point) => this._getState(point) === nodeState);
        if (adjacentNodes.length >= 2) {
          return false;
        }
        for (const adjacentNode of adjacentNodes) {
          const adjacentExistingNodes = this.getAdjacentPositions(adjacentNode).filter((point) => this._getState(point) === nodeState);
          if (adjacentExistingNodes.length >= 1) {
            return false;
          }
        }
        return true;
      }
      _isInProtectionZone(point, player) {
        if (!this.isValidPosition(point)) return false;
        return this._getOpponents(player).some((opponent) => {
          if (this.protectionRule === StartProtectionRule.DUEL_FIRST_UNPROTECTED && this.playerCount === 2 && this.boardShape === "triangle" && opponent === this.startPlayer) {
            return false;
          }
          return this._getRoots(opponent).some((root) => {
            const dx = point[0] - root[0], dy = point[1] - root[1];
            return DIRECTIONS.some(([x, y]) => dx === x && dy === y);
          });
        });
      }
      // ── 边集合辅助方法 ────────────────────────────────────────────────────
      /** 生成两节点的规范边 key（与顺序无关）*/
      _edgeKey(a, b) {
        const ka = pointKey(a);
        const kb = pointKey(b);
        return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      }
      /** 返回对应玩家的显式边集合 */
      _getEdges(player) {
        return this.edges[player];
      }
      /** 移除因线点被删除而断裂的边 */
      _cleanupBrokenEdges(player) {
        const { node: nodeState, line: lineState } = this._getPlayerStates(player);
        const edgeSet = this._getEdges(player);
        for (const ek of [...edgeSet]) {
          const [ka, kb] = ek.split("|");
          const linePoints = this.getLinePoints(keyToPoint(ka), keyToPoint(kb));
          const intact = linePoints.every((p) => {
            const s = this._getState(p);
            return s === nodeState || s === lineState;
          });
          if (!intact) {
            edgeSet.delete(ek);
          }
        }
      }
      /**
       * 以对手起始点为根，通过显式边集做 BFS，返回所有存活棋子格点的 key 集合。
       * 先清理已断裂的边，再沿边图遍历可达节点，最后把每条存活边的中间线点也纳入集合。
       * 物理相邻但不属于任何边端点的"路过线"不会被误判为连通。
       */
      _getOpponentConnectedPieces(opponent) {
        const { node: nodeState } = this._getPlayerStates(opponent);
        const roots = this._getRoots(opponent).filter((root) => this._getState(root) === nodeState);
        if (!roots.length) return /* @__PURE__ */ new Set();
        this._cleanupBrokenEdges(opponent);
        const edgeSet = this._getEdges(opponent);
        const adj = /* @__PURE__ */ new Map();
        for (const ek of edgeSet) {
          const [ka, kb] = ek.split("|");
          if (!adj.has(ka)) adj.set(ka, []);
          if (!adj.has(kb)) adj.set(kb, []);
          adj.get(ka).push(kb);
          adj.get(kb).push(ka);
        }
        const rootKeys = roots.map(pointKey);
        const aliveNodes = new Set(rootKeys);
        const queue = [...rootKeys];
        while (queue.length > 0) {
          const curr = queue.shift();
          for (const nxt of adj.get(curr) ?? []) {
            if (!aliveNodes.has(nxt)) {
              aliveNodes.add(nxt);
              queue.push(nxt);
            }
          }
        }
        const alive = new Set(aliveNodes);
        for (const ek of edgeSet) {
          const [ka, kb] = ek.split("|");
          if (aliveNodes.has(ka) && aliveNodes.has(kb)) {
            for (const p of this.getLinePoints(keyToPoint(ka), keyToPoint(kb))) {
              alive.add(pointKey(p));
            }
          }
        }
        return alive;
      }
      /** 移除所有经过指定节点的边 */
      _removeNodeEdges(node, player) {
        const nk = pointKey(node);
        const edgeSet = this._getEdges(player);
        for (const ek of [...edgeSet]) {
          const [ka, kb] = ek.split("|");
          if (ka === nk || kb === nk) {
            edgeSet.delete(ek);
          }
        }
      }
      // ─────────────────────────────────────────────────────────────────────
      /** 通过显式边图（BFS）判断节点是否连通到起始节点 */
      _isConnectedToInitial(point, player) {
        const roots = this._getRoots(player);
        if (roots.some((root) => pointEquals(point, root))) {
          return true;
        }
        const edgeSet = this._getEdges(player);
        const adj = /* @__PURE__ */ new Map();
        for (const ek of edgeSet) {
          const [ka, kb] = ek.split("|");
          if (!adj.has(ka)) adj.set(ka, []);
          if (!adj.has(kb)) adj.set(kb, []);
          adj.get(ka).push(kb);
          adj.get(kb).push(ka);
        }
        const targetKey = pointKey(point);
        const rootKeys = roots.map(pointKey);
        const visited = new Set(rootKeys);
        const queue = [...rootKeys];
        while (queue.length > 0) {
          const curr = queue.shift();
          if (curr === targetKey) return true;
          for (const nxt of adj.get(curr) ?? []) {
            if (!visited.has(nxt)) {
              visited.add(nxt);
              queue.push(nxt);
            }
          }
        }
        return false;
      }
      /**
       * 仅还原攻击前已存在的边（不新建从未显式连接的边）。
       * 领土边界经过的空点不是线段，攻击后不应被自动连线赋予 LINE 状态。
       */
      _restoreEdges(player, edgesSnapshot) {
        const { node: nodeState, line: lineState } = this._getPlayerStates(player);
        const edgeSet = this._getEdges(player);
        for (const ek of edgesSnapshot) {
          if (edgeSet.has(ek)) continue;
          const [ka, kb] = ek.split("|");
          const nodeA = keyToPoint(ka);
          const nodeB = keyToPoint(kb);
          if (this._getState(nodeA) !== nodeState || this._getState(nodeB) !== nodeState) continue;
          if (!this.canConnectWithBlocking(nodeA, nodeB, player)) continue;
          const linePoints = this.getLinePoints(nodeA, nodeB);
          for (const point of linePoints) {
            if (pointEquals(point, nodeA) || pointEquals(point, nodeB)) {
              this._setState(point, nodeState);
            } else if (this._getState(point) === PointState.EMPTY) {
              this._setState(point, lineState);
            }
          }
          edgeSet.add(ek);
        }
      }
      _getCrawlRays(node) {
        this._crawlRays ??= /* @__PURE__ */ new Map();
        const key3 = pointKey(node);
        if (!this._crawlRays.has(key3)) {
          const rays = DIRECTIONS.map(([dx, dy]) => {
            const ray = [];
            let x = node[0] + dx, y = node[1] + dy;
            while (this.isValidPosition([x, y])) {
              ray.push({ point: [x, y], key: `${x},${y}` });
              x += dx;
              y += dy;
            }
            return ray;
          });
          this._crawlRays.set(key3, rays);
        }
        return this._crawlRays.get(key3);
      }
      /** 攻击结束后，沿6个方向爬行重建所有被解锁的连线 */
      _connectAllCrawl(player, knownNodes = null) {
        const { node: nodeState, line: lineState } = this._getPlayerStates(player);
        const oppStates = this._getOpponents(player).flatMap((opp) => {
          const s = this._getPlayerStates(opp);
          return [s.node, s.line];
        });
        const isEnemy = /* @__PURE__ */ __name((state) => oppStates.includes(state), "isEnemy");
        const edgeSet = this._getEdges(player);
        const nodes = knownNodes ?? this._getPlayerNodes(player);
        for (const node of nodes) {
          for (const ray of this._getCrawlRays(node)) {
            for (let index = 0; index < ray.length; index++) {
              const st = this.grid.get(ray[index].key);
              if (isEnemy(st)) break;
              if (st === nodeState) {
                const other = ray[index].point;
                const ek = this._edgeKey(node, other);
                if (!edgeSet.has(ek)) {
                  for (let before = 0; before < index; before++) {
                    if (this.grid.get(ray[before].key) === PointState.EMPTY) {
                      this._setState(ray[before].point, lineState);
                    }
                  }
                  edgeSet.add(ek);
                }
                break;
              }
            }
          }
        }
      }
      _handleBlockingAttack(newPoint, player, originalState) {
        const opponent = this._getPlayerByLineState(originalState);
        if (!opponent || opponent === player) {
          return;
        }
        const opponentStates = this._getPlayerStates(opponent);
        const savedEdges = Object.fromEntries(
          this.activePlayers.map((p) => [p, new Set(this._getEdges(p))])
        );
        const alive = this._getOpponentConnectedPieces(opponent);
        let removedPieces = 0;
        for (const point of this.validPositions) {
          const state = this._getState(point);
          if ((state === opponentStates.node || state === opponentStates.line) && !alive.has(pointKey(point))) {
            this._setState(point, PointState.EMPTY);
            removedPieces += 1;
          }
        }
        this._getEdges(opponent).clear();
        for (const activePlayer of this.activePlayers) {
          this._cleanupBrokenEdges(activePlayer);
        }
        if (removedPieces > 0) {
          for (const activePlayer of this.activePlayers) {
            this._restoreEdges(activePlayer, savedEdges[activePlayer]);
          }
          return;
        }
        this._restoreEdges(player, savedEdges[player]);
        this._restoreEdges(opponent, savedEdges[opponent]);
      }
      getAllShortestGridPaths(start, end, blockedPoints = [], maxEdges = Infinity) {
        this._assertValidPosition(start);
        this._assertValidPosition(end);
        if (pointEquals(start, end)) {
          return [[clonePoint(start)]];
        }
        const blocked = new Set(blockedPoints.map(pointKey));
        blocked.delete(pointKey(start));
        blocked.delete(pointKey(end));
        const startKey = pointKey(start);
        const endKey = pointKey(end);
        const queue = [clonePoint(start)];
        let qi = 0;
        const distances2 = /* @__PURE__ */ new Map([[startKey, 0]]);
        const predecessors = /* @__PURE__ */ new Map();
        while (qi < queue.length) {
          const current = queue[qi++];
          const currentKey = pointKey(current);
          const currentDistance = distances2.get(currentKey);
          for (const next of this.getAdjacentPositions(current)) {
            const nextKey = pointKey(next);
            if (blocked.has(nextKey)) {
              continue;
            }
            const nextDistance = currentDistance + 1;
            if (!distances2.has(nextKey)) {
              distances2.set(nextKey, nextDistance);
              predecessors.set(nextKey, [currentKey]);
              queue.push(next);
            } else if (distances2.get(nextKey) === nextDistance) {
              predecessors.get(nextKey).push(currentKey);
            }
          }
        }
        if (!distances2.has(endKey)) {
          return [];
        }
        if (distances2.get(endKey) > maxEdges) {
          return [];
        }
        const buildPaths = /* @__PURE__ */ __name((currentKey) => {
          if (currentKey === startKey) {
            return [[clonePoint(start)]];
          }
          const result = [];
          const prevKeys = predecessors.get(currentKey) ?? [];
          for (const prevKey of prevKeys) {
            for (const path of buildPaths(prevKey)) {
              result.push(path.concat([keyToPoint(currentKey)]));
            }
          }
          return result;
        }, "buildPaths");
        return buildPaths(endKey);
      }
      /** 阶段一：右手摸墙法 — 获取外轮廓 */
      _getOuterContour(player) {
        return this._getOuterContourFromPoints([
          ...this._getPlayerNodes(player),
          ...this._getPlayerLines(player)
        ]);
      }
      _getOuterContourFromPoints(friendlyPoints) {
        const friendlySet = /* @__PURE__ */ new Set();
        for (const p of friendlyPoints) {
          friendlySet.add(pointKey(p));
        }
        if (friendlySet.size === 0) return [];
        let start = null;
        for (const key3 of friendlySet) {
          const p = keyToPoint(key3);
          if (!start || p[0] < start[0] || p[0] === start[0] && p[1] < start[1]) {
            start = p;
          }
        }
        if (friendlySet.size === 1) return [clonePoint(start)];
        let backtrack = 3;
        const contour = [];
        let current = clonePoint(start);
        let firstOutDir = null;
        const maxSteps = friendlySet.size * 6 + 10;
        for (let step = 0; step < maxSteps; step += 1) {
          let outDir = null;
          for (let i = 0; i < 6; i += 1) {
            const d = (backtrack + 1 + i) % 6;
            const [dx2, dy2] = DIRS_CW[d];
            const nxt = [current[0] + dx2, current[1] + dy2];
            if (friendlySet.has(pointKey(nxt))) {
              outDir = d;
              break;
            }
          }
          if (outDir === null) {
            contour.push(clonePoint(current));
            break;
          }
          if (firstOutDir === null) {
            firstOutDir = outDir;
            contour.push(clonePoint(current));
          } else if (pointEquals(current, start) && outDir === firstOutDir) {
            break;
          } else {
            contour.push(clonePoint(current));
          }
          const [dx, dy] = DIRS_CW[outDir];
          current = [current[0] + dx, current[1] + dy];
          backtrack = (outDir + 3) % 6;
        }
        return contour;
      }
      /** A closed walk only encloses territory when its undirected boundary graph
       *  contains a real cycle. This rejects out-and-back lines such as
       *  A-B-C-B, which the legacy flood fill counted as three territory points. */
      _hasBoundaryCycle(polygon) {
        if (!Array.isArray(polygon) || polygon.length < 3) return false;
        const points = pointEquals(polygon[0], polygon[polygon.length - 1]) ? polygon.slice(0, -1) : polygon;
        if (points.length < 3) return false;
        const vertices = /* @__PURE__ */ new Set();
        const edges = /* @__PURE__ */ new Set();
        const gridPointCount = this.validPositions.length;
        for (let index = 0; index < points.length; index += 1) {
          const start = points[index];
          const end = points[(index + 1) % points.length];
          if (pointEquals(start, end)) continue;
          const startIdx = this._pointToIndex(start);
          const endIdx = this._pointToIndex(end);
          if (startIdx < 0 || endIdx < 0) return false;
          const dx = end[0] - start[0];
          const dy = end[1] - start[1];
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dx + dy)) !== 1) return false;
          vertices.add(startIdx);
          vertices.add(endIdx);
          const left = Math.min(startIdx, endIdx);
          const right = Math.max(startIdx, endIdx);
          edges.add(left * gridPointCount + right);
        }
        return vertices.size >= 3 && edges.size >= vertices.size;
      }
      /** 阶段三：泛洪法领土判定 — 从边缘注水，未被淹没即为领土
       *  内部全程使用整数下标 + TypedArray，零字符串分配，比原版快 10x+ */
      _getCoveredPoints(polygon) {
        this._bfsEpoch += 1;
        if (this._bfsEpoch === 2147483647) {
          this._bfsWall.fill(0);
          this._bfsWater.fill(0);
          this._bfsRequired.fill(0);
          this._bfsEpoch = 1;
        }
        const epoch = this._bfsEpoch;
        const wall = this._bfsWall;
        const water = this._bfsWater;
        const queue = this._bfsQueue;
        const indexedGeometry = this._rowIndexGridSize === this.gridSize && this._rowIndexBoardShape === this.boardShape;
        for (const p of polygon) {
          const directIdx = indexedGeometry ? this._pointToIndex(p) : -1;
          const idx = directIdx >= 0 ? directIdx : this._keyToIdx.get(pointKey(p));
          if (idx >= 0) wall[idx] = epoch;
        }
        let qlen = 0;
        for (const i of this._boundaryIdxs) {
          if (wall[i] !== epoch && water[i] !== epoch) {
            water[i] = epoch;
            queue[qlen++] = i;
          }
        }
        let qi = 0;
        while (qi < qlen) {
          const curr = queue[qi++];
          for (const nxt of this._adjIdxList[curr]) {
            if (wall[nxt] !== epoch && water[nxt] !== epoch) {
              water[nxt] = epoch;
              queue[qlen++] = nxt;
            }
          }
        }
        const count = this.validPositions.length - qlen;
        const waterSnap = new Int32Array(water);
        const capturedEpoch = epoch;
        const keyToIdx = this._keyToIdx;
        return {
          size: count,
          /** 判断 grid 坐标 key 是否在领土内（未被水淹没） */
          has(k) {
            const idx = keyToIdx.get(k);
            return idx !== void 0 && waterSnap[idx] !== capturedEpoch;
          }
        };
      }
      /** Exact boolean form of the native flood-fill coverage test. Envelope
       *  pruning only needs to know whether every friendly node stays dry, so it
       *  can stop at the first flooded friend and need not copy the water buffer.
       *  Full coverage callers still receive an independent snapshot above. */
      _coversFriendlyNodes(polygon, friendlyKeys) {
        if (this._getCoveredPoints !== NATIVE_FLOOD_COVERAGE || this._pointToIndex !== NATIVE_FLOOD_POINT_INDEX) {
          const covered = this._getCoveredPoints(polygon);
          return [...friendlyKeys].every((key3) => covered.has(key3));
        }
        this._bfsEpoch += 1;
        if (this._bfsEpoch === 2147483647) {
          this._bfsWall.fill(0);
          this._bfsWater.fill(0);
          this._bfsRequired.fill(0);
          this._bfsEpoch = 1;
        }
        const epoch = this._bfsEpoch;
        const wall = this._bfsWall, water = this._bfsWater;
        const required = this._bfsRequired, queue = this._bfsQueue;
        const indexedGeometry = this._rowIndexGridSize === this.gridSize && this._rowIndexBoardShape === this.boardShape;
        for (const point of polygon) {
          const directIdx = indexedGeometry ? this._pointToIndex(point) : -1;
          const index = directIdx >= 0 ? directIdx : this._keyToIdx.get(pointKey(point));
          if (index >= 0) wall[index] = epoch;
        }
        let needsFlood = false;
        for (const key3 of friendlyKeys) {
          const index = this._keyToIdx.get(key3);
          if (index === void 0) return false;
          if (wall[index] !== epoch) {
            required[index] = epoch;
            needsFlood = true;
          }
        }
        if (!needsFlood) return true;
        let length = 0;
        for (const index of this._boundaryIdxs) {
          if (wall[index] !== epoch && water[index] !== epoch) {
            if (required[index] === epoch) return false;
            water[index] = epoch;
            queue[length++] = index;
          }
        }
        for (let head = 0; head < length; head++) {
          for (const next of this._adjIdxList[queue[head]]) {
            if (wall[next] !== epoch && water[next] !== epoch) {
              if (required[next] === epoch) return false;
              water[next] = epoch;
              queue[length++] = next;
            }
          }
        }
        return true;
      }
      /** Exact candidate validation without exporting a coverage snapshot. Only
       *  this synchronous scalar result escapes; public coverage remains detached. */
      _getValidatedTerritoryArea(polygon, friendlyKeys, enemyKeys) {
        if (this._getCoveredPoints !== NATIVE_FLOOD_COVERAGE || this._pointToIndex !== NATIVE_FLOOD_POINT_INDEX) {
          const covered = this._getCoveredPoints(polygon);
          if (![...friendlyKeys].every((key3) => covered.has(key3))) return null;
          if ([...enemyKeys].some((key3) => covered.has(key3))) return null;
          return covered.size;
        }
        this._bfsEpoch += 1;
        if (this._bfsEpoch === 2147483647) {
          this._bfsWall.fill(0);
          this._bfsWater.fill(0);
          this._bfsRequired.fill(0);
          this._bfsEpoch = 1;
        }
        const epoch = this._bfsEpoch;
        const wall = this._bfsWall, water = this._bfsWater;
        const required = this._bfsRequired, queue = this._bfsQueue;
        const indexedGeometry = this._rowIndexGridSize === this.gridSize && this._rowIndexBoardShape === this.boardShape;
        for (const point of polygon) {
          const directIdx = indexedGeometry ? this._pointToIndex(point) : -1;
          const index = directIdx >= 0 ? directIdx : this._keyToIdx.get(pointKey(point));
          if (index >= 0) wall[index] = epoch;
        }
        for (const key3 of friendlyKeys) {
          const index = this._keyToIdx.get(key3);
          if (index === void 0) return null;
          required[index] = epoch;
        }
        let length = 0;
        for (const index of this._boundaryIdxs) {
          if (wall[index] !== epoch && water[index] !== epoch) {
            if (required[index] === epoch) return null;
            water[index] = epoch;
            queue[length++] = index;
          }
        }
        for (let head = 0; head < length; head++) {
          for (const next of this._adjIdxList[queue[head]]) {
            if (wall[next] !== epoch && water[next] !== epoch) {
              if (required[next] === epoch) return null;
              water[next] = epoch;
              queue[length++] = next;
            }
          }
        }
        for (const key3 of enemyKeys) {
          const index = this._keyToIdx.get(key3);
          if (index !== void 0 && water[index] !== epoch) return null;
        }
        return this.validPositions.length - length;
      }
      /** 从源点对整张棋盘做 BFS（整数下标），返回距离表和前驱表。
       *  使用预计算的 _adjIdxList，避免热路径中的字符串操作。 */
      _bfsFromSource(srcIdx, enemyIdxSet) {
        if (!NATIVE_DEPENDENCY_METHODS.every(([name, method]) => this[name] === method) || !(enemyIdxSet instanceof Set) || Object.getPrototypeOf(enemyIdxSet) !== Set.prototype || enemyIdxSet.has !== Set.prototype.has || enemyIdxSet[Symbol.iterator] !== Set.prototype[Symbol.iterator] || !Number.isInteger(srcIdx) || srcIdx < 0 || srcIdx >= this.validPositions.length) {
          return this._territoryBfsUncached(srcIdx, enemyIdxSet);
        }
        const memo = dependencyMemo(this);
        if (!memo.context) updateDependencyGeometry(this, memo);
        const obstacleKey = memo.context?.enemyIdxSet === enemyIdxSet ? memo.context.obstacleKey : [...enemyIdxSet].filter((index) => Number.isInteger(index) && index >= 0 && index < this.validPositions.length).sort((a, b) => a - b).join(",");
        if (memo.context) Object.assign(memo.context, { enemyIdxSet, obstacleKey });
        const exact = dependencyBfsGet(memo.bfs, obstacleKey, srcIdx);
        if (exact) {
          memo.stats.bfsExactHits++;
          return unpackDependencyBfs(exact.result);
        }
        let checked = 0;
        for (const [oldKey, group] of [...memo.bfs.groups].reverse()) {
          const entry = group.entries.get(srcIdx);
          if (!entry) continue;
          if (++checked > 2) break;
          if (entry.dependencies.every((state, index) => !state || enemyIdxSet.has(index) === (state === 2))) {
            dependencyBfsGet(memo.bfs, oldKey, srcIdx);
            memo.stats.bfsDependencyHits++;
            dependencyBfsPut(memo.bfs, obstacleKey, srcIdx, entry);
            return unpackDependencyBfs(entry.result);
          }
        }
        memo.stats.bfsMisses++;
        const result = this._territoryBfsUncached(srcIdx, enemyIdxSet);
        if ((memo.bfs.groups.get(obstacleKey)?.entries.size || 0) >= 6) return result;
        const dependencies = new Uint8Array(this.validPositions.length);
        for (let index = 0; index < result.dist.length; index++) {
          if (result.dist[index] < 0) continue;
          for (const next of this._adjIdxList[index]) dependencies[next] = enemyIdxSet.has(next) ? 2 : 1;
        }
        const units = result.dist.length * 3 + 1 + result.pred.reduce((sum, previous) => sum + (previous?.length || 0), 0);
        dependencyBfsPut(memo.bfs, obstacleKey, srcIdx, { dependencies, units, result: packDependencyBfs(result) });
        return result;
      }
      _territoryBfsUncached(srcIdx, enemyIdxSet) {
        const gridN = this.validPositions.length;
        const dist = new Int32Array(gridN).fill(-1);
        const pred = new Array(gridN).fill(null);
        dist[srcIdx] = 0;
        const queue = [srcIdx];
        let qi = 0;
        while (qi < queue.length) {
          const curr = queue[qi++];
          const cd = dist[curr];
          for (const nxt of this._adjIdxList[curr]) {
            if (enemyIdxSet.has(nxt)) continue;
            const nd = cd + 1;
            if (dist[nxt] === -1) {
              dist[nxt] = nd;
              pred[nxt] = [curr];
              queue.push(nxt);
            } else if (dist[nxt] === nd) {
              pred[nxt].push(curr);
            }
          }
        }
        return { dist, pred };
      }
      /** Stream shortest paths from a predecessor DAG. The legacy implementation
       *  materialized every path at once, causing exponential peak memory. */
      *_iterateReconstructedPaths(bfsResult, srcIdx, tgtIdx) {
        const { dist, pred } = bfsResult;
        if (dist[tgtIdx] === -1) return;
        const vp = this.validPositions;
        const reversedPath = [tgtIdx];
        function* visit(index) {
          if (index === srcIdx) {
            yield [...reversedPath].reverse().map((pointIndex) => clonePoint(vp[pointIndex]));
            return;
          }
          for (const previous of pred[index] ?? []) {
            reversedPath.push(previous);
            yield* visit(previous);
            reversedPath.pop();
          }
        }
        __name(visit, "visit");
        yield* visit(tgtIdx);
      }
      // Compatibility helper for diagnostics that explicitly request an array.
      _reconstructPaths(bfsResult, srcIdx, tgtIdx) {
        return [...this._iterateReconstructedPaths(bfsResult, srcIdx, tgtIdx)];
      }
      /** Keep old diagnostic/subclass overrides observable while the default path
       *  remains streaming and does not materialize the predecessor DAG. */
      *_iterateTerritoryPaths(bfsResult, srcIdx, tgtIdx) {
        if (this._reconstructPaths !== _GameEngine.prototype._reconstructPaths) {
          yield* this._reconstructPaths(bfsResult, srcIdx, tgtIdx);
          return;
        }
        yield* this._iterateReconstructedPaths(bfsResult, srcIdx, tgtIdx);
      }
      /** Prune a predecessor subtree only when its entire remaining wall union
       *  cannot contain the required friendly nodes. This keeps the native path
       *  order and every potentially valid path, without a path-count budget. */
      *_iterateCoveredTerritoryPaths(bfsResult, srcIdx, tgtIdx, fixedA, fixedB, friendlyKeys, possibleSides, sharedPaths = null, areaLimit = null) {
        const { pred, dist } = bfsResult;
        if (dist[tgtIdx] === -1) return;
        const vp = this.validPositions;
        const counts2 = sharedPaths?.counts ?? /* @__PURE__ */ new Map([[srcIdx, 1]]);
        const countPaths = /* @__PURE__ */ __name((index) => {
          if (!counts2.has(index)) {
            let count = 0;
            for (const previous of pred[index] ?? []) count = Math.min(16, count + countPaths(previous));
            counts2.set(index, count);
          }
          return counts2.get(index);
        }, "countPaths");
        if (countPaths(tgtIdx) < 16 && (!sharedPaths || !areaLimit)) {
          if (!sharedPaths) {
            yield* this._iterateTerritoryPaths(bfsResult, srcIdx, tgtIdx);
            return;
          }
          for (const path of this._iterateTerritoryPaths(bfsResult, srcIdx, tgtIdx)) {
            const sides = possibleSides();
            if (!sides) return;
            if (sharedPaths) sharedPaths.emittedSides = sides;
            yield path;
          }
          return;
        }
        const makeAreaBound = /* @__PURE__ */ __name((fixed) => {
          const required = new Set([...fixed.map(pointKey), ...friendlyKeys].map((key3) => this._keyToIdx.get(key3)).filter((index) => index !== void 0));
          const weight = /* @__PURE__ */ __name((index) => required.has(index) ? 0 : 1, "weight");
          const costs = /* @__PURE__ */ new Map([[srcIdx, weight(srcIdx)]]);
          const minimumExtra = /* @__PURE__ */ __name((index) => {
            if (!costs.has(index)) {
              let best = Infinity;
              for (const previous of pred[index] ?? []) best = Math.min(best, minimumExtra(previous));
              costs.set(index, best + weight(index));
            }
            return costs.get(index);
          }, "minimumExtra");
          return { required, weight, minimumExtra };
        }, "makeAreaBound");
        const areaBounds = sharedPaths && areaLimit ? [makeAreaBound(fixedA), makeAreaBound(fixedB)] : null;
        const ancestors = /* @__PURE__ */ new Map();
        const ancestorPoints = /* @__PURE__ */ __name((index) => {
          if (!ancestors.has(index)) {
            const union = /* @__PURE__ */ new Set([index]), pending2 = [index];
            for (let i = 0; i < pending2.length; i++) {
              for (const previous of pred[pending2[i]] ?? []) {
                if (!union.has(previous)) {
                  union.add(previous);
                  pending2.push(previous);
                }
              }
            }
            ancestors.set(index, [...union].map((i) => vp[i]));
          }
          return ancestors.get(index);
        }, "ancestorPoints");
        const engine = this;
        const reversedPath = [tgtIdx];
        function* visit(index, inheritedSides, extraA, extraB) {
          let sides = sharedPaths ? possibleSides() & inheritedSides : possibleSides();
          if (!sides) return;
          if (areaBounds) {
            for (let side = 0; side < 2; side++) {
              const bit = 1 << side;
              if (!(sides & bit)) continue;
              const limit = areaLimit(bit);
              if (limit === Infinity) continue;
              const bound = areaBounds[side];
              const lowerArea = bound.required.size + (side ? extraB : extraA) + bound.minimumExtra(index) - bound.weight(index);
              if (lowerArea >= limit) sides &= ~bit;
            }
            if (!sides) return;
          }
          if (index === srcIdx) {
            if (sharedPaths) sharedPaths.emittedSides = sides;
            yield [...reversedPath].reverse().map((i) => clonePoint(vp[i]));
            return;
          }
          if (reversedPath.length > 1 && counts2.get(index) >= 16) {
            const envelope = [...reversedPath.map((i) => vp[i]), ...ancestorPoints(index)];
            const couldCover = /* @__PURE__ */ __name((fixed) => {
              if (sharedPaths) return engine._coversFriendlyNodes([...fixed, ...envelope], friendlyKeys);
              const covered = engine._getCoveredPoints([...fixed, ...envelope]);
              return [...friendlyKeys].every((key3) => covered.has(key3));
            }, "couldCover");
            if (sharedPaths) {
              if (sides & 1 && !couldCover(fixedA)) sides &= ~1;
              if (sides & 2 && !couldCover(fixedB)) sides &= ~2;
              if (!sides) return;
            } else if (!(sides & 1 && couldCover(fixedA)) && !(sides & 2 && couldCover(fixedB))) return;
          }
          for (const previous of pred[index] ?? []) {
            reversedPath.push(previous);
            yield* visit(
              previous,
              sides,
              extraA + (areaBounds ? areaBounds[0].weight(previous) : 0),
              extraB + (areaBounds ? areaBounds[1].weight(previous) : 0)
            );
            reversedPath.pop();
          }
        }
        __name(visit, "visit");
        yield* visit(
          tgtIdx,
          3,
          areaBounds ? areaBounds[0].weight(tgtIdx) : 0,
          areaBounds ? areaBounds[1].weight(tgtIdx) : 0
        );
      }
      /** Raw contour-tightening scorer over an explicitly supplied coordinate view. */
      _computeRawTerritory(friendlyNodes, friendlyLines, rawEnemyPoints, { requireClosedRegion = false, initialContour = null } = {}) {
        const options = { requireClosedRegion, initialContour };
        if (!NATIVE_DEPENDENCY_METHODS.every(([name, method]) => this[name] === method)) {
          return this._rawTerritoryUncached(friendlyNodes, friendlyLines, rawEnemyPoints, options);
        }
        const nodeKey = dependencyPointsKey(friendlyNodes), lineKey = dependencyPointsKey(friendlyLines);
        const enemyKey = dependencyPointsKey(rawEnemyPoints), contourKey = initialContour ? dependencyPointsKey(initialContour) : "";
        if ([nodeKey, lineKey, enemyKey, contourKey].some((key4) => key4 === null)) {
          return this._rawTerritoryUncached(friendlyNodes, friendlyLines, rawEnemyPoints, options);
        }
        const memo = dependencyMemo(this);
        updateDependencyGeometry(this, memo);
        const key3 = `${requireClosedRegion ? 1 : 0}|${nodeKey}|${lineKey}|${[...new Set(enemyKey.split(";"))].sort().join(";")}|${initialContour ? 1 : 0}:${contourKey}`;
        const cached = dependencyGet(memo.raw, key3);
        if (cached) {
          memo.stats.rawHits++;
          return copyDependencyTerritory(cached);
        }
        memo.stats.rawMisses++;
        const previousContext = memo.context;
        memo.context = {};
        try {
          const result = this._rawTerritoryUncached(friendlyNodes, friendlyLines, rawEnemyPoints, options);
          dependencyPut(memo.raw, key3, copyDependencyTerritory(result), (result.polygon?.length || 0) * 2);
          return result;
        } finally {
          memo.context = previousContext;
        }
      }
      _getTerritoryDependencyStats() {
        const memo = dependencyMemo(this);
        return {
          ...memo.stats,
          rawEntries: memo.raw.entries.size,
          rawKeyCharacters: memo.raw.characters,
          rawCoordinateUnits: memo.raw.units,
          bfsEntries: memo.bfs.entries,
          bfsObstacleGroups: memo.bfs.groups.size,
          bfsKeyCharacters: memo.bfs.characters,
          bfsNumericUnits: memo.bfs.units
        };
      }
      _rawTerritoryUncached(friendlyNodes, friendlyLines, rawEnemyPoints, { requireClosedRegion = false, initialContour = null } = {}) {
        const friendlyNodeKeys = new Set(friendlyNodes.map(pointKey));
        const usePathEnvelope = requireClosedRegion && NATIVE_TERRITORY_METHODS.every(([name, method]) => this[name] === method);
        const useSharedValidation = usePathEnvelope && NATIVE_SHARED_TERRITORY_METHODS.every(([name, method]) => this[name] === method);
        const useScalarValidation = useSharedValidation;
        const enemyPoints = dedupePoints(rawEnemyPoints);
        const enemyKeySet = new Set(enemyPoints.map(pointKey));
        const enemyIdxSet = /* @__PURE__ */ new Set();
        for (const ep of enemyPoints) {
          const idx = this._keyToIdx.get(pointKey(ep));
          if (idx !== void 0) enemyIdxSet.add(idx);
        }
        let currentPoly = initialContour ? initialContour.map(clonePoint) : this._getOuterContourFromPoints([...friendlyNodes, ...friendlyLines]);
        if (currentPoly.length < 3 || requireClosedRegion && !this._hasBoundaryCycle(currentPoly)) {
          return { polygon: null, area: 0, displayArea: 0 };
        }
        let curArea = 0;
        const bfsBySource = /* @__PURE__ */ new Map();
        const sharedValidatedWallPerimeters = useSharedValidation ? /* @__PURE__ */ new Map() : null;
        while (true) {
          const polyLen = currentPoly.length;
          if (polyLen < 3) break;
          const usePerimeterBounds = usePathEnvelope && currentPoly.every((point, index) => index === 0 || !pointEquals(point, currentPoly[index - 1]));
          const curCovered = this._getCoveredPoints(currentPoly);
          curArea = curCovered.size;
          const curPerim = polyLen;
          let bestOverallCand = null;
          let bestCandPerim = curPerim;
          let bestCandArea = curArea;
          const validatedWallPerimeters = sharedValidatedWallPerimeters ?? (requireClosedRegion ? /* @__PURE__ */ new Map() : null);
          const considerFullyValidatedCandidate = /* @__PURE__ */ __name((rawCandidate) => {
            const candidate = rawCandidate.filter(
              (point, index) => index === 0 || !pointEquals(point, rawCandidate[index - 1])
            );
            if (candidate.length < 3 || candidate.length > bestCandPerim) return;
            const wallKey = this._getWallSetKey(candidate);
            if (wallKey === null) return;
            const previousPerimeter = validatedWallPerimeters.get(wallKey);
            if (previousPerimeter !== void 0 && previousPerimeter <= candidate.length) return;
            if (!this._hasBoundaryCycle(candidate)) return;
            validatedWallPerimeters.set(wallKey, candidate.length);
            const covered = useScalarValidation ? null : this._getCoveredPoints(candidate);
            const area = useScalarValidation ? this._getValidatedTerritoryArea(candidate, friendlyNodeKeys, enemyKeySet) : covered.size;
            if (area === null) return;
            if (candidate.length === bestCandPerim && area >= bestCandArea) return;
            if (!useScalarValidation && ![...friendlyNodeKeys].every((key3) => covered.has(key3))) return;
            if (!useScalarValidation && [...enemyKeySet].some((key3) => covered.has(key3))) return;
            bestCandPerim = candidate.length;
            bestCandArea = area;
            bestOverallCand = candidate;
          }, "considerFullyValidatedCandidate");
          const bfsCache = new Array(polyLen);
          for (let i = 0; i < polyLen - 2; i += 1) {
            const srcIdx = this._keyToIdx.get(pointKey(currentPoly[i]));
            if (srcIdx !== void 0) {
              if (!bfsBySource.has(srcIdx)) {
                const bfs = this._bfsFromSource(srcIdx, enemyIdxSet);
                bfsBySource.set(srcIdx, {
                  srcIdx,
                  dist: bfs.dist,
                  pred: bfs.pred,
                  // These subproblems depend only on this source and the fixed
                  // obstacle map, so all endpoint pairs and tightening rounds in
                  // this one raw scoring pass can share them.
                  paths: { counts: /* @__PURE__ */ new Map([[srcIdx, 1]]) }
                });
              }
              bfsCache[i] = bfsBySource.get(srcIdx);
            } else {
              bfsCache[i] = null;
            }
          }
          for (let i = 0; i < polyLen; i += 1) {
            if (!bfsCache[i]) continue;
            const { srcIdx, dist: distI } = bfsCache[i];
            for (let j = polyLen - 1; j > i + 1; j -= 1) {
              const arcLen = j - i;
              const tgtIdx = this._keyToIdx.get(pointKey(currentPoly[j]));
              if (tgtIdx === void 0) continue;
              const shortestDist = distI[tgtIdx];
              if (shortestDist === -1 || shortestDist >= arcLen) continue;
              let possibleA = true, possibleB = true;
              const perimeterA = polyLen - arcLen + shortestDist;
              const perimeterB = arcLen + 1 + Math.max(0, shortestDist - 1);
              if (usePathEnvelope) {
                possibleA = !usePerimeterBounds || perimeterA <= bestCandPerim;
                possibleB = !usePerimeterBounds || perimeterB <= bestCandPerim;
                if (!possibleA && !possibleB) continue;
                const union = /* @__PURE__ */ new Set([tgtIdx]), pending2 = [tgtIdx];
                for (let k = 0; k < pending2.length; k++) {
                  for (const previous of bfsCache[i].pred[pending2[k]] || []) {
                    if (!union.has(previous)) {
                      union.add(previous);
                      pending2.push(previous);
                    }
                  }
                }
                const pathEnvelope = [...union].map((index) => this.validPositions[index]);
                const couldCoverNodes = /* @__PURE__ */ __name((wall) => {
                  if (useSharedValidation) return this._coversFriendlyNodes(wall, friendlyNodeKeys);
                  const covered = this._getCoveredPoints(wall);
                  return [...friendlyNodeKeys].every((key3) => covered.has(key3));
                }, "couldCoverNodes");
                possibleA = possibleA && couldCoverNodes([...currentPoly.slice(0, i), ...pathEnvelope, ...currentPoly.slice(j + 1)]);
                possibleB = possibleB && couldCoverNodes([...currentPoly.slice(i, j + 1), ...pathEnvelope]);
                if (!possibleA && !possibleB) continue;
              }
              const possibleSides = /* @__PURE__ */ __name(() => (possibleA && (!usePerimeterBounds || perimeterA <= bestCandPerim) ? 1 : 0) | (possibleB && (!usePerimeterBounds || perimeterB <= bestCandPerim) ? 2 : 0), "possibleSides");
              const paths = usePathEnvelope ? this._iterateCoveredTerritoryPaths(
                bfsCache[i],
                srcIdx,
                tgtIdx,
                [...currentPoly.slice(0, i), ...currentPoly.slice(j + 1)],
                currentPoly.slice(i, j + 1),
                friendlyNodeKeys,
                possibleSides,
                useSharedValidation ? bfsCache[i].paths : null,
                useSharedValidation && usePerimeterBounds ? (side) => (side === 1 ? perimeterA : perimeterB) === bestCandPerim ? bestCandArea : Infinity : null
              ) : this._iterateTerritoryPaths(bfsCache[i], srcIdx, tgtIdx);
              for (const path of paths) {
                if (usePerimeterBounds && !possibleSides()) break;
                const candidateSides = useSharedValidation ? bfsCache[i].paths.emittedSides & possibleSides() : 3;
                const pathLen = path.length;
                const pathInterior = path.slice(1, -1);
                if (requireClosedRegion) {
                  const reversedMiddle = pathInterior.slice().reverse();
                  if (possibleA && candidateSides & 1) considerFullyValidatedCandidate([
                    ...currentPoly.slice(0, i),
                    ...path,
                    ...currentPoly.slice(j + 1)
                  ]);
                  if (possibleB && candidateSides & 2) considerFullyValidatedCandidate([
                    ...currentPoly.slice(i, j + 1),
                    ...reversedMiddle
                  ]);
                  continue;
                }
                const isInward = pathInterior.every((p) => curCovered.has(pointKey(p)));
                if (isInward) {
                  const revMid = pathInterior.slice().reverse();
                  let wedge = [...currentPoly.slice(i, j + 1), ...revMid];
                  wedge = wedge.filter((p, k) => k === 0 || !pointEquals(p, wedge[k - 1]));
                  if (wedge.length < 3) continue;
                  const wedgeCovered = this._getCoveredPoints(wedge);
                  const wedgeArea = wedgeCovered.size;
                  const pathKeySet = new Set(path.map(pointKey));
                  const candAArea = curArea - wedgeArea + 2 * (pathLen - 1);
                  const candAPerim = curPerim - arcLen + (pathLen - 1);
                  if (candAPerim <= bestCandPerim && !(candAPerim === bestCandPerim && candAArea >= bestCandArea)) {
                    const candANodeOk = [...friendlyNodeKeys].every(
                      (k) => !wedgeCovered.has(k) || pathKeySet.has(k)
                    );
                    if (candANodeOk) {
                      let candA = [...currentPoly.slice(0, i), ...path, ...currentPoly.slice(j + 1)];
                      candA = candA.filter((p, k) => k === 0 || !pointEquals(p, candA[k - 1]));
                      if (candA.length >= 3) {
                        bestCandPerim = candAPerim;
                        bestCandArea = candAArea;
                        bestOverallCand = candA;
                      }
                    }
                  }
                  {
                    const candBPerim = wedge.length;
                    const candBArea = wedgeArea;
                    if (candBPerim <= bestCandPerim && !(candBPerim === bestCandPerim && candBArea >= bestCandArea)) {
                      const candBNodeOk = [...friendlyNodeKeys].every((k) => wedgeCovered.has(k));
                      const candBEnemyOk = ![...enemyKeySet].some((k) => wedgeCovered.has(k));
                      if (candBNodeOk && candBEnemyOk) {
                        bestCandPerim = candBPerim;
                        bestCandArea = candBArea;
                        bestOverallCand = wedge;
                      }
                    }
                  }
                } else {
                  const revMid = pathInterior.slice().reverse();
                  for (let cand of [
                    [...currentPoly.slice(0, i), ...path, ...currentPoly.slice(j + 1)],
                    [...currentPoly.slice(i, j + 1), ...revMid]
                  ]) {
                    cand = cand.filter((p, k) => k === 0 || !pointEquals(p, cand[k - 1]));
                    if (cand.length < 3) continue;
                    const candPerim = cand.length;
                    if (candPerim > bestCandPerim) continue;
                    const covered = this._getCoveredPoints(cand);
                    const candArea = covered.size;
                    if (candPerim === bestCandPerim && candArea >= bestCandArea) continue;
                    if (![...friendlyNodeKeys].every((k) => covered.has(k))) continue;
                    if ([...enemyKeySet].some((k) => covered.has(k))) continue;
                    bestCandPerim = candPerim;
                    bestCandArea = candArea;
                    bestOverallCand = cand;
                  }
                }
              }
            }
          }
          if (bestOverallCand !== null) {
            currentPoly = bestOverallCand;
          } else {
            break;
          }
        }
        if (currentPoly.length < 3 || requireClosedRegion && !this._hasBoundaryCycle(currentPoly)) {
          return { polygon: null, area: 0, displayArea: 0 };
        }
        if (requireClosedRegion) {
          const finalCovered = this._getCoveredPoints(currentPoly);
          if ([...enemyKeySet].some((key3) => finalCovered.has(key3))) {
            return { polygon: null, area: 0, displayArea: 0 };
          }
          curArea = finalCovered.size;
        }
        const closedPoly = [...currentPoly, clonePoint(currentPoly[0])];
        return { polygon: closedPoly, area: curArea, displayArea: computeTriangularPolygonArea(currentPoly) };
      }
      _getCanonicalTerritoryTransforms(player) {
        if (this.boardShape === "diamond") {
          if (this.playerCount === 2) {
            return player === Player.BLACK ? [DIAMOND_TRANSFORMS.IDENTITY, DIAMOND_TRANSFORMS.SWAP_XY] : [DIAMOND_TRANSFORMS.ROTATE_180, DIAMOND_TRANSFORMS.SWAP_ANTI_DIAGONAL];
          }
          return Object.values(DIAMOND_TRANSFORMS);
        }
        if (this.playerCount > 6) return this.boardShape === "hexagon" ? [{ rotation: 0, reflected: false }, { rotation: 0, reflected: true }] : [BARYCENTRIC_TRANSFORMS.IDENTITY, BARYCENTRIC_TRANSFORMS.SWAP_XY];
        if (this.boardShape === "hexagon") {
          const vertexIndex = this.boardVertices.findIndex(
            (point) => pointEquals(point, buildInitialPositions(this.gridSize, this.playerCount, this.boardShape)[player])
          );
          return [
            { rotation: -vertexIndex, reflected: false },
            { rotation: -vertexIndex, reflected: true }
          ];
        }
        if (this.playerCount === 2) {
          return player === Player.BLACK ? [BARYCENTRIC_TRANSFORMS.IDENTITY] : [BARYCENTRIC_TRANSFORMS.SWAP_XZ];
        }
        if (player === Player.GREEN) return [BARYCENTRIC_TRANSFORMS.IDENTITY, BARYCENTRIC_TRANSFORMS.SWAP_YZ];
        if (player === Player.ORANGE) return [BARYCENTRIC_TRANSFORMS.CYCLE_XZY, BARYCENTRIC_TRANSFORMS.SWAP_XZ];
        if (player === Player.CYAN) return [BARYCENTRIC_TRANSFORMS.CYCLE_XYZ, BARYCENTRIC_TRANSFORMS.SWAP_XY];
        if (player === Player.BLACK) {
          return [BARYCENTRIC_TRANSFORMS.IDENTITY, BARYCENTRIC_TRANSFORMS.SWAP_XY];
        }
        if (player === Player.WHITE) {
          return [BARYCENTRIC_TRANSFORMS.SWAP_YZ, BARYCENTRIC_TRANSFORMS.CYCLE_XZY];
        }
        return [BARYCENTRIC_TRANSFORMS.CYCLE_XYZ, BARYCENTRIC_TRANSFORMS.SWAP_XZ];
      }
      _computeCanonicalTerritoryCandidate(player, permutation) {
        const isHexagon = this.boardShape === "hexagon";
        const isDiamond = this.boardShape === "diamond";
        const transform = /* @__PURE__ */ __name((point) => isHexagon ? applyHexTransform(point, this.gridSize, permutation) : isDiamond ? applyDiamondTransform(point, this.gridSize, permutation) : applyBarycentricTransform(point, this.gridSize, permutation), "transform");
        const friendlyNodes = this._getPlayerNodes(player).map(transform);
        const friendlyLines = this._getPlayerLines(player).map(transform);
        const enemyPoints = this._getOpponents(player).flatMap((opponent) => [
          ...this._getPlayerNodes(opponent).map(transform),
          ...this._getPlayerLines(opponent).map(transform)
        ]);
        const canonicalTerritory = this._computeRawTerritory(
          friendlyNodes,
          friendlyLines,
          enemyPoints,
          { requireClosedRegion: true }
        );
        const inverse = isHexagon || isDiamond ? null : invertPermutation(permutation);
        const polygon = canonicalTerritory.polygon ? canonicalTerritory.polygon.map(
          (point) => isHexagon ? applyHexTransform(point, this.gridSize, permutation, true) : isDiamond ? applyDiamondTransform(point, this.gridSize, permutation) : applyBarycentricTransform(point, this.gridSize, inverse)
        ) : null;
        return {
          canonicalKey: canonicalPolygonKey(canonicalTerritory.polygon),
          territory: { ...canonicalTerritory, polygon }
        };
      }
      /** Return every officially counted v3 point in stable board order.
       *  Treat every friendly node/line point as a flood-fill wall. This handles
       *  open chains, several pockets and ring-shaped structures with holes; no
       *  single simple polygon is required for the score. */
      _computeOwnedWallTerritory(ownedPoints, enemyPoints) {
        const ownedKeys = new Set(ownedPoints.map(pointKey));
        const enemyKeys = new Set(enemyPoints.map(pointKey));
        const covered = this._getCoveredPoints(ownedPoints);
        const visited = /* @__PURE__ */ new Set();
        const includedKeys = new Set(ownedKeys);
        for (const point of this.validPositions) {
          const startKey = pointKey(point);
          if (ownedKeys.has(startKey) || visited.has(startKey) || !covered.has(startKey)) continue;
          const queue = [point];
          visited.add(startKey);
          let containsEnemy = false;
          for (let head = 0; head < queue.length; head += 1) {
            const current = queue[head];
            const currentKey = pointKey(current);
            if (enemyKeys.has(currentKey)) containsEnemy = true;
            for (const neighbor of this.getAdjacentPositions(current)) {
              const key3 = pointKey(neighbor);
              if (ownedKeys.has(key3) || visited.has(key3) || !covered.has(key3)) continue;
              visited.add(key3);
              queue.push(neighbor);
            }
          }
          if (!containsEnemy) {
            for (const point2 of queue) includedKeys.add(pointKey(point2));
          }
        }
        const renderPoints = this.validPositions.filter((point) => includedKeys.has(pointKey(point))).map(clonePoint);
        return { area: renderPoints.length, renderPoints };
      }
      _computeOwnedWallArea(ownedPoints, enemyPoints) {
        return this._computeOwnedWallTerritory(ownedPoints, enemyPoints).area;
      }
      /** Public scoring dispatch. v1 is the frozen legacy implementation. v2
       *  requires an actual boundary cycle and scores every player in a canonical
       *  base-oriented coordinate view. Three-player scoring minimizes over the
       *  two transformations in the base stabilizer. Hexagonal boards use the
       *  corresponding D6 base stabilizer and never triangular barycentrics. */
      _computeTerritory(player) {
        switch (this.rulesVersion) {
          case TerritoryRulesVersion.V1:
            return this._computeRawTerritory(
              this._getPlayerNodes(player),
              this._getPlayerLines(player),
              this._getOpponents(player).flatMap((opponent) => [
                ...this._getPlayerNodes(opponent),
                ...this._getPlayerLines(opponent)
              ]),
              { initialContour: this._getOuterContour(player) }
            );
          case TerritoryRulesVersion.V2:
          case TerritoryRulesVersion.V3:
            break;
          default:
            throw new Error(`Unsupported territory rules version: ${this.rulesVersion}`);
        }
        const candidates = this._getCanonicalTerritoryTransforms(player).map((permutation) => this._computeCanonicalTerritoryCandidate(player, permutation));
        candidates.sort((left, right) => left.territory.area - right.territory.area || left.canonicalKey.localeCompare(right.canonicalKey));
        const territory = candidates[0].territory;
        if (this.rulesVersion === TerritoryRulesVersion.V2) return territory;
        const ownedPoints = [...this._getPlayerNodes(player), ...this._getPlayerLines(player)];
        const enemyPoints = this._getOpponents(player).flatMap((opponent) => [
          ...this._getPlayerNodes(opponent),
          ...this._getPlayerLines(opponent)
        ]);
        const ownedTerritory = this._computeOwnedWallTerritory(ownedPoints, enemyPoints);
        return {
          ...territory,
          area: ownedTerritory.area,
          displayArea: territory.polygon ? territory.displayArea : ownedPoints.length,
          renderPoints: ownedTerritory.renderPoints
        };
      }
      /** 将当前局面序列化为唯一字符串，用于 Superko 判断。
       *  包含：网格物理层（非空点）、逻辑拓扑层（各方边集合）、即将行棋方。 */
      _getStateHashOrder() {
        this._stateHashCoordinates ??= /* @__PURE__ */ new Map();
        return [...this.grid.keys()].map((key3) => {
          if (!this._stateHashCoordinates.has(key3)) {
            const [x, y] = key3.split(",").map(Number);
            this._stateHashCoordinates.set(key3, { key: key3, x, y, cells: /* @__PURE__ */ new Map() });
          }
          return this._stateHashCoordinates.get(key3);
        }).sort((a, b) => a.x - b.x || a.y - b.y);
      }
      _computeStateHash(nextPlayer, orderedPoints = this._getStateHashOrder()) {
        const gridEntries = [];
        for (const entry of orderedPoints) {
          const state = this.grid.get(entry.key);
          if (state === PointState.EMPTY) continue;
          if (!entry.cells.has(state)) entry.cells.set(state, JSON.stringify([entry.x, entry.y, state]));
          gridEntries.push(entry.cells.get(state));
        }
        const edgeLists = this.activePlayers.map(
          (player) => [...this._getEdges(player)].sort()
        );
        const resignedPlayers = this.activePlayers.filter((player) => this.resignedPlayers.has(player));
        const classicHash = `[${JSON.stringify(nextPlayer)},${JSON.stringify(resignedPlayers)},[${gridEntries.join(",")}],${JSON.stringify(edgeLists)}]`;
        if (this.rootRulesVersion === RootRulesVersion.V1) return classicHash;
        const rootIdentity = this.activePlayers.map((player) => ({
          player,
          roots: this._getRoots(player).map(pointKey).sort(),
          relocate: this.rootActionsRemaining[player]?.relocate ?? 0,
          add: this.rootActionsRemaining[player]?.add ?? 0
        }));
        return `${classicHash}|${this.rootRulesVersion}|${this.rootMode}|${JSON.stringify(rootIdentity)}`;
      }
      _updateTerritories() {
        for (const player of this.activePlayers) {
          this.cachedTerritories[player] = this._computeTerritory(player);
        }
        this._territoryCacheRevision = this._territoryStateRevision;
      }
      _switchPlayer() {
        const currentIndex = this.activePlayers.indexOf(this.currentPlayer);
        for (let offset = 1; offset <= this.activePlayers.length; offset += 1) {
          const nextPlayer = this.activePlayers[(currentIndex + offset) % this.activePlayers.length];
          if (!this.resignedPlayers.has(nextPlayer)) {
            this.currentPlayer = nextPlayer;
            return;
          }
        }
      }
      _getNextPlayer(player = this.currentPlayer) {
        const currentIndex = this.activePlayers.indexOf(player);
        for (let offset = 1; offset <= this.activePlayers.length; offset += 1) {
          const nextPlayer = this.activePlayers[(currentIndex + offset) % this.activePlayers.length];
          if (!this.resignedPlayers.has(nextPlayer)) {
            return nextPlayer;
          }
        }
        return player;
      }
      _getRemainingPlayers() {
        return this.activePlayers.filter((player) => !this.resignedPlayers.has(player));
      }
      _checkResignationFinish() {
        const remainingPlayers = this._getRemainingPlayers();
        if (remainingPlayers.length <= 1) {
          this.gameOver = true;
          if (remainingPlayers.length === 1) {
            this.currentPlayer = remainingPlayers[0];
          }
          return true;
        }
        return false;
      }
      _evaluateMove(point, player = this.currentPlayer, sourceNodes = null, hashOrder = void 0) {
        if (this.resignedPlayers.has(player)) {
          return { legal: false, reason: "PLAYER_RESIGNED", state: null, isAttack: false };
        }
        if (!this.isValidPosition(point)) {
          return { legal: false, reason: "INVALID_MOVE", state: null, isAttack: false };
        }
        const originalState = this._getState(point);
        const attackableLineStates = new Set(
          this._getOpponents(player).map((opponent) => this._getPlayerStates(opponent).line)
        );
        const isAttackingMove = attackableLineStates.has(originalState);
        const currentPlayerSnapshot = this.currentPlayer;
        const gridSnapshot = this.grid;
        const previousUndo = this._moveProbeUndo;
        const undo = /* @__PURE__ */ new Map();
        const edgesSnapshot = Object.fromEntries(
          this.activePlayers.map((candidate) => [candidate, new Set(this._getEdges(candidate))])
        );
        try {
          this._moveProbeUndo = undo;
          this.currentPlayer = player;
          const success = this._addNode(point, sourceNodes);
          if (!success) {
            return { legal: false, reason: "INVALID_MOVE", state: originalState, isAttack: isAttackingMove };
          }
          const stateHash = this._computeStateHash(this._getNextPlayer(player), hashOrder);
          if (this.historyHashes.has(stateHash)) {
            return {
              legal: false,
              reason: "SUPERKO_VIOLATION",
              state: originalState,
              isAttack: isAttackingMove
            };
          }
          return { legal: true, reason: null, state: originalState, isAttack: isAttackingMove };
        } finally {
          this.grid = gridSnapshot;
          for (const [key3, state] of undo) {
            if (state === void 0) this.grid.delete(key3);
            else this.grid.set(key3, state);
          }
          this._moveProbeUndo = previousUndo;
          for (const candidate of this.activePlayers) {
            this.edges[candidate] = edgesSnapshot[candidate];
          }
          this.currentPlayer = currentPlayerSnapshot;
        }
      }
      _hasValidMoves(player) {
        if (this.resignedPlayers.has(player)) {
          return false;
        }
        const sourceNodes = this._getPlayerNodes(player);
        const hashOrder = this._getStateHashOrder();
        for (const point of this.validPositions) {
          if (this._evaluateMove(point, player, sourceNodes, hashOrder).legal) {
            return true;
          }
        }
        return false;
      }
      _validateRootAction(type, point, player = this.currentPlayer) {
        if (this.gameOver) return "GAME_OVER";
        if (!this.activePlayers.includes(player)) return "UNKNOWN_PLAYER";
        if (player !== this.currentPlayer) return "NOT_PLAYER_TURN";
        if (this.resignedPlayers.has(player)) return "PLAYER_RESIGNED";
        if (!isBoardPoint(point, this.gridSize, this.playerCount, this.boardShape)) return "INVALID_ROOT_TARGET";
        if (!["relocate", "add"].includes(type) || this.rootMode !== type) return "ROOT_ACTION_UNAVAILABLE";
        if ((this.rootActionsRemaining[player]?.[type] ?? 0) <= 0) return "ROOT_ACTION_EXHAUSTED";
        if (this._getState(point) !== this._getPlayerStates(player).node) return "ROOT_TARGET_NOT_OWN_NODE";
        if (this._getRoots(player).some((root) => pointEquals(root, point))) return "ROOT_TARGET_ALREADY_ROOT";
        if (type === "add" && this._getRoots(player).length >= 2) return "ROOT_LIMIT_REACHED";
        if (type === "relocate" && !this._isConnectedToInitial(point, player)) return "ROOT_TARGET_DISCONNECTED";
        if (this._isInProtectionZone(point, player)) return "ROOT_TARGET_IN_ENEMY_PROTECTION";
        const enemyStates = new Set(this._getOpponents(player).flatMap((opponent) => {
          const states = this._getPlayerStates(opponent);
          return [states.node, states.line];
        }));
        if (this.getAdjacentPositions(point).some((neighbor) => enemyStates.has(this._getState(neighbor)))) {
          return "ROOT_PROTECTION_OVERLAPS_ENEMY";
        }
        return null;
      }
      getLegalRootActions(player = this.currentPlayer) {
        if (!this.activePlayers.includes(player) || player !== this.currentPlayer) return [];
        const type = this.rootMode === RootMode.RELOCATE ? "relocate" : this.rootMode === RootMode.ADD ? "add" : null;
        if (!type) return [];
        return this._getPlayerNodes(player).filter((point) => this._validateRootAction(type, point, player) == null).map((point) => ({ type: `root_${type}`, point: clonePoint(point) }));
      }
      _hasAnyNonPassAction(player) {
        return this._hasValidMoves(player) || player === this.currentPlayer && this.getLegalRootActions(player).length > 0;
      }
      getLegalMoves(player = this.currentPlayer) {
        const result = [];
        const sourceNodes = this._getPlayerNodes(player);
        const hashOrder = this._getStateHashOrder();
        for (const point of this.validPositions) {
          const evaluation = this._evaluateMove(point, player, sourceNodes, hashOrder);
          if (evaluation.legal) {
            result.push({
              point: clonePoint(point),
              state: evaluation.state,
              isAttack: evaluation.isAttack
            });
          }
        }
        return result;
      }
      _checkAndAutoSkip() {
        if (this.gameOver) {
          return;
        }
        if (this._checkResignationFinish()) {
          return;
        }
        if (this.resignedPlayers.has(this.currentPlayer)) {
          this._switchPlayer();
          this._checkAndAutoSkip();
          return;
        }
        if (!this._hasAnyNonPassAction(this.currentPlayer)) {
          this.consecutiveSkips += 1;
          if (this.consecutiveSkips >= this._getRemainingPlayers().length) {
            this.gameOver = true;
          } else {
            this._switchPlayer();
            this._checkAndAutoSkip();
          }
        }
      }
      _addNode(point, sourceNodes = null) {
        if (!this.isValidPosition(point)) {
          return false;
        }
        const originalState = this._getState(point);
        const occupiableLineStates = new Set(this.activePlayers.map((player) => this._getPlayerStates(player).line));
        if (originalState !== PointState.EMPTY && !occupiableLineStates.has(originalState)) {
          return false;
        }
        if (this._isInProtectionZone(point, this.currentPlayer)) {
          return false;
        }
        const currentStates = this._getPlayerStates(this.currentPlayer);
        const attackableLineStates = new Set(
          this._getOpponents(this.currentPlayer).map((opponent) => this._getPlayerStates(opponent).line)
        );
        const isAttackingMove = attackableLineStates.has(originalState);
        if (!isAttackingMove && !this._checkThreePointLimitation(point, this.currentPlayer)) {
          return false;
        }
        this._setState(point, currentStates.node);
        const existingNodes = sourceNodes ?? this._getPlayerNodes(this.currentPlayer).filter((node) => !pointEquals(node, point));
        let connected = false;
        for (const node of existingNodes) {
          if (!this.canConnectWithBlocking(point, node, this.currentPlayer)) {
            continue;
          }
          connected = true;
          const linePoints = this.getLinePoints(point, node);
          for (const linePoint of linePoints) {
            if (pointEquals(linePoint, point) || pointEquals(linePoint, node)) {
              this._setState(linePoint, currentStates.node);
            } else if (this._getState(linePoint) === PointState.EMPTY || this._getState(linePoint) === currentStates.line) {
              this._setState(linePoint, currentStates.line);
            }
          }
          this._getEdges(this.currentPlayer).add(this._edgeKey(point, node));
        }
        if (!connected) {
          this._setState(point, originalState);
          return false;
        }
        this._handleBlockingAttack(point, this.currentPlayer, originalState);
        const crawlNodes = sourceNodes ? [...sourceNodes, point].sort((a, b) => a[1] - b[1] || a[0] - b[0]) : null;
        this._connectAllCrawl(this.currentPlayer, crawlNodes);
        if (isAttackingMove) {
          for (const player of this.activePlayers) {
            if (player !== this.currentPlayer) this._connectAllCrawl(player);
          }
        }
        return true;
      }
      _createActionResult(success, reason) {
        return {
          success,
          reason,
          snapshot: this._isReplayingBatch ? null : this.getSnapshot()
        };
      }
      _captureReplayState() {
        return {
          grid: new Map(this.grid),
          edges: Object.fromEntries(
            this.activePlayers.map((player) => [player, new Set(this._getEdges(player))])
          ),
          historyHashes: new Set(this.historyHashes),
          ...!this.isTopologyBoard ? {
            roots: Object.fromEntries(this.activePlayers.map((player) => [player, this.getRoots(player)])),
            rootActionsRemaining: cloneRootActions(this.rootActionsRemaining)
          } : {},
          currentPlayer: this.currentPlayer,
          gameOver: this.gameOver,
          consecutiveSkips: this.consecutiveSkips,
          resignedPlayers: new Set(this.resignedPlayers),
          turnCount: this.turnCount,
          positionRevision: this.positionRevision,
          territoryStateRevision: this._territoryStateRevision,
          territoryCacheRevision: this._territoryCacheRevision,
          cachedTerritories: Object.fromEntries(
            this.activePlayers.map((player) => {
              const territory = this.cachedTerritories[player];
              return [player, {
                ...territory,
                polygon: territory.polygon ? territory.polygon.map(clonePoint) : null,
                ...Array.isArray(territory.renderPoints) ? { renderPoints: territory.renderPoints.map(clonePoint) } : {}
              }];
            })
          )
        };
      }
      _restoreReplayState(state) {
        this.grid = new Map(state.grid);
        this.edges = Object.fromEntries(
          this.activePlayers.map((player) => [player, new Set(state.edges[player])])
        );
        this.historyHashes = new Set(state.historyHashes);
        if (!this.isTopologyBoard) {
          this.roots = Object.fromEntries(this.activePlayers.map((player) => [
            player,
            (state.roots?.[player] ?? this.initialRoots[player]).map(clonePoint)
          ]));
          this.rootActionsRemaining = cloneRootActions(state.rootActionsRemaining ?? Object.fromEntries(
            this.activePlayers.map((player) => [player, { relocate: 0, add: 0 }])
          ));
        }
        this.currentPlayer = state.currentPlayer;
        this.gameOver = state.gameOver;
        this.consecutiveSkips = state.consecutiveSkips;
        this.resignedPlayers = new Set(state.resignedPlayers);
        this.turnCount = state.turnCount;
        this.positionRevision = state.positionRevision;
        this._territoryStateRevision = state.territoryStateRevision ?? this.positionRevision;
        this._territoryCacheRevision = state.territoryCacheRevision ?? this._territoryStateRevision;
        this.cachedTerritories = Object.fromEntries(
          this.activePlayers.map((player) => {
            const territory = state.cachedTerritories[player];
            return [player, {
              ...territory,
              polygon: territory.polygon ? territory.polygon.map(clonePoint) : null,
              ...Array.isArray(territory.renderPoints) ? { renderPoints: territory.renderPoints.map(clonePoint) } : {}
            }];
          })
        );
      }
      replayBatch(callback) {
        if (typeof callback !== "function") {
          throw new Error("replayBatch(callback) requires a synchronous callback.");
        }
        if (Object.prototype.toString.call(callback) === "[object AsyncFunction]") {
          throw new Error("replayBatch(callback) does not accept async callbacks.");
        }
        if (this._isReplayingBatch) {
          throw new Error("Nested replay batches are not supported.");
        }
        const transaction = new _GameEngine({
          gridSize: this.gridSize,
          playerCount: this.playerCount,
          boardShape: this.boardShape,
          startPlayer: this.startPlayer,
          initialPositions: this.hasCustomInitialPositions ? this.initialPositions : void 0,
          initialRoots: this.initialRoots,
          rootMode: this.rootMode,
          rootRulesVersion: this.rootRulesVersion,
          rulesVersion: this.rulesVersion,
          protectionRule: this.protectionRule
        });
        transaction._restoreReplayState(this._captureReplayState());
        let result;
        transaction._isReplayingBatch = true;
        try {
          result = callback(transaction);
          if (result && typeof result.then === "function") {
            Promise.resolve(result).catch(() => {
            });
            throw new Error("replayBatch(callback) does not accept Promise results.");
          }
        } finally {
          transaction._isReplayingBatch = false;
        }
        if (!result || result.success !== true) {
          return {
            ...result ?? {},
            success: false,
            reason: result?.reason ?? "REPLAY_FAILED",
            snapshot: null
          };
        }
        transaction._updateTerritories();
        const snapshot = transaction.getSnapshot();
        this._restoreReplayState(transaction._captureReplayState());
        return {
          ...result,
          snapshot
        };
      }
      playMove(point) {
        if (this.gameOver) {
          return this._createActionResult(false, "GAME_OVER");
        }
        const normalizedPoint = clonePoint(point);
        const gridSnapshot = new Map(this.grid);
        const edgesSnapshot = Object.fromEntries(
          this.activePlayers.map((player) => [player, new Set(this._getEdges(player))])
        );
        const success = this._addNode(normalizedPoint);
        if (!success) {
          return this._createActionResult(false, "INVALID_MOVE");
        }
        const stateHash = this._computeStateHash(this._getNextPlayer(this.currentPlayer));
        if (this.historyHashes.has(stateHash)) {
          this.grid = gridSnapshot;
          for (const player of this.activePlayers) {
            this.edges[player] = edgesSnapshot[player];
          }
          return this._createActionResult(false, "SUPERKO_VIOLATION");
        }
        this.historyHashes.add(stateHash);
        this.turnCount += 1;
        this.positionRevision += 1;
        this._territoryStateRevision += 1;
        this.consecutiveSkips = 0;
        this._switchPlayer();
        this._checkAndAutoSkip();
        if (!this._isReplayingBatch) {
          if (!this.deferTerritoryUpdates || this.gameOver) {
            this._updateTerritories();
          }
        }
        return this._createActionResult(true, null);
      }
      playRootAction(type, point) {
        const normalizedType = String(type ?? "").replace(/^root_/, "");
        const normalizedPoint = Array.isArray(point) ? clonePoint(point) : point;
        const reason = this._validateRootAction(normalizedType, normalizedPoint, this.currentPlayer);
        if (reason) return this._createActionResult(false, reason);
        const before = this._captureReplayState();
        const actingPlayer = this.currentPlayer;
        try {
          if (normalizedType === "relocate") this.roots[actingPlayer] = [clonePoint(normalizedPoint)];
          else this.roots[actingPlayer] = [...this.roots[actingPlayer].map(clonePoint), clonePoint(normalizedPoint)];
          this.rootActionsRemaining[actingPlayer][normalizedType] -= 1;
          const stateHash = this._computeStateHash(this._getNextPlayer(actingPlayer));
          if (this.historyHashes.has(stateHash)) {
            this._restoreReplayState(before);
            return this._createActionResult(false, "SUPERKO_VIOLATION");
          }
          this.historyHashes.add(stateHash);
          this.turnCount += 1;
          this.positionRevision += 1;
          this._territoryStateRevision += 1;
          this.consecutiveSkips = 0;
          this._switchPlayer();
          this._checkAndAutoSkip();
          if (!this._isReplayingBatch && (!this.deferTerritoryUpdates || this.gameOver)) this._updateTerritories();
          return this._createActionResult(true, null);
        } catch (_error) {
          this._restoreReplayState(before);
          return this._createActionResult(false, "ROOT_ACTION_FAILED");
        }
      }
      skipTurn() {
        if (this.gameOver) {
          return this._createActionResult(false, "GAME_OVER");
        }
        this.consecutiveSkips += 1;
        this.positionRevision += 1;
        if (this.consecutiveSkips >= this._getRemainingPlayers().length) {
          this.gameOver = true;
        } else {
          this._switchPlayer();
          this._checkAndAutoSkip();
        }
        return this._createActionResult(true, null);
      }
      resignPlayer(player = this.currentPlayer) {
        if (this.gameOver) {
          return this._createActionResult(false, "GAME_OVER");
        }
        if (!this.activePlayers.includes(player)) {
          return this._createActionResult(false, "UNKNOWN_PLAYER");
        }
        if (this.resignedPlayers.has(player)) {
          return this._createActionResult(false, "PLAYER_ALREADY_RESIGNED");
        }
        this.resignedPlayers.add(player);
        this.turnCount += 1;
        this.positionRevision += 1;
        this.consecutiveSkips = 0;
        if (!this._checkResignationFinish() && this.currentPlayer === player) {
          this._switchPlayer();
          this._checkAndAutoSkip();
        } else if (!this.gameOver && this.resignedPlayers.has(this.currentPlayer)) {
          this._switchPlayer();
          this._checkAndAutoSkip();
        }
        return this._createActionResult(true, null);
      }
    };
    NATIVE_TERRITORY_METHODS = Object.freeze([
      "_bfsFromSource",
      "_reconstructPaths",
      "_iterateReconstructedPaths",
      "_iterateTerritoryPaths",
      "_iterateCoveredTerritoryPaths",
      "_getCoveredPoints"
    ].map((name) => [name, GameEngine.prototype[name]]));
    NATIVE_SHARED_TERRITORY_METHODS = Object.freeze([
      "_pointToIndex",
      "_getWallSetKey",
      "_getOuterContourFromPoints",
      "_hasBoundaryCycle",
      "_territoryBfsUncached",
      "_coversFriendlyNodes",
      "_getValidatedTerritoryArea"
    ].map((name) => [name, GameEngine.prototype[name]]));
    NATIVE_FLOOD_COVERAGE = GameEngine.prototype._getCoveredPoints;
    NATIVE_FLOOD_POINT_INDEX = GameEngine.prototype._pointToIndex;
    TERRITORY_DEPENDENCY_MEMOS = /* @__PURE__ */ new WeakMap();
    NATIVE_DEPENDENCY_METHODS = Object.freeze([
      "_pointToIndex",
      "_getWallSetKey",
      "_getOuterContourFromPoints",
      "_hasBoundaryCycle",
      "_getCoveredPoints",
      "_bfsFromSource",
      "_territoryBfsUncached",
      "_rawTerritoryUncached",
      "_coversFriendlyNodes",
      "_getValidatedTerritoryArea",
      "_reconstructPaths",
      "_iterateReconstructedPaths",
      "_iterateTerritoryPaths",
      "_iterateCoveredTerritoryPaths"
    ].map((name) => [name, GameEngine.prototype[name]]));
    __name(dependencyBucket, "dependencyBucket");
    __name(dependencyMemo, "dependencyMemo");
    __name(updateDependencyGeometry, "updateDependencyGeometry");
    __name(dependencyGet, "dependencyGet");
    __name(dependencyPut, "dependencyPut");
    __name(dependencyPointsKey, "dependencyPointsKey");
    __name(copyDependencyTerritory, "copyDependencyTerritory");
    __name(dependencyBfsBucket, "dependencyBfsBucket");
    __name(dependencyBfsGet, "dependencyBfsGet");
    __name(dependencyBfsPut, "dependencyBfsPut");
    __name(packDependencyBfs, "packDependencyBfs");
    __name(unpackDependencyBfs, "unpackDependencyBfs");
    GameEngine_default = GameEngine;
  }
});

// application-hard:RootModeSearch.js
function pointKey2(point) {
  return `${point[0]},${point[1]}`;
}
function getOpponents(engine, player) {
  return engine._getOpponents ? engine._getOpponents(player) : engine.activePlayers.filter((candidate) => candidate !== player);
}
function cloneCachedTerritories(engine) {
  return Object.fromEntries(
    engine.activePlayers.map((player) => {
      const territory = engine.cachedTerritories[player];
      return [
        player,
        {
          ...territory,
          polygon: territory.polygon ? territory.polygon.map((point) => [...point]) : null
        }
      ];
    })
  );
}
function saveState(engine) {
  return {
    grid: new Map(engine.grid),
    edges: Object.fromEntries(
      engine.activePlayers.map((player) => [player, new Set(engine.edges[player] ?? [])])
    ),
    historyHashes: new Set(engine.historyHashes),
    // Root state is rule state for root-v2, not a presentation annotation.
    // Snapshot it with grid/edges so speculative AI branches cannot leak a
    // relocation/addition into their siblings or the caller.
    roots: Object.fromEntries(engine.activePlayers.map((player) => [player, engine.getRoots(player)])),
    rootActionsRemaining: cloneValue(engine.rootActionsRemaining),
    consecutiveSkips: engine.consecutiveSkips,
    resignedPlayers: new Set(engine.resignedPlayers ?? []),
    currentPlayer: engine.currentPlayer,
    gameOver: engine.gameOver,
    turnCount: engine.turnCount,
    positionRevision: engine.positionRevision ?? 0,
    territoryStateRevision: engine._territoryStateRevision ?? engine.positionRevision ?? 0,
    territoryCacheRevision: engine._territoryCacheRevision ?? engine._territoryStateRevision ?? engine.positionRevision ?? 0,
    cachedTerritories: cloneCachedTerritories(engine)
  };
}
function restoreState(engine, snapshot) {
  engine.grid = new Map(snapshot.grid);
  engine.edges = Object.fromEntries(
    engine.activePlayers.map((player) => [player, new Set(snapshot.edges[player] ?? [])])
  );
  engine.historyHashes = new Set(snapshot.historyHashes);
  engine.roots = Object.fromEntries(engine.activePlayers.map((player) => [
    player,
    cloneValue(snapshot.roots?.[player] ?? engine.initialRoots[player])
  ]));
  engine.rootActionsRemaining = cloneValue(snapshot.rootActionsRemaining ?? engine.rootActionsRemaining);
  engine.consecutiveSkips = snapshot.consecutiveSkips;
  engine.resignedPlayers = new Set(snapshot.resignedPlayers ?? []);
  engine.currentPlayer = snapshot.currentPlayer;
  engine.gameOver = snapshot.gameOver;
  engine.turnCount = snapshot.turnCount;
  engine.positionRevision = snapshot.positionRevision ?? engine.positionRevision ?? 0;
  engine._territoryStateRevision = snapshot.territoryStateRevision ?? engine.positionRevision;
  engine._territoryCacheRevision = snapshot.territoryCacheRevision ?? engine._territoryStateRevision;
  engine.cachedTerritories = snapshot.cachedTerritories;
}
function applyMoveForAI(engine, point, skipLeafAutoSkip = false) {
  const originalAutoSkip = skipLeafAutoSkip ? engine._checkAndAutoSkip : null;
  if (skipLeafAutoSkip) {
    engine._checkAndAutoSkip = () => {
    };
  }
  try {
    const result = engine.playMove(point);
    return result.success;
  } finally {
    if (skipLeafAutoSkip) {
      engine._checkAndAutoSkip = originalAutoSkip;
    }
  }
}
function isRootSearchAction(action) {
  return action && !Array.isArray(action) && ["root_relocate", "root_add"].includes(action.type);
}
function cloneSearchAction(action) {
  if (action === null) return null;
  if (Array.isArray(action)) return [...action];
  return { type: action.type, point: [...action.point] };
}
function searchActionKey(action) {
  if (action === null) return "pass";
  if (Array.isArray(action)) return `move:${pointKey2(action)}`;
  return `${action.type}:${pointKey2(action.point)}`;
}
function legalSearchActions(engine, player) {
  const placements = engine.getLegalMoves(player).map((move) => move.point);
  const rootActions = player === engine.currentPlayer ? engine.getLegalRootActions(player).map(cloneSearchAction) : [];
  return [...placements, ...rootActions];
}
function applySearchAction(engine, action, skipLeafAutoSkip = false) {
  if (action === null || action?.type === "pass") return engine.skipTurn().success;
  if (isRootSearchAction(action)) return engine.playRootAction(action.type, action.point).success;
  return applyMoveForAI(engine, Array.isArray(action) ? action : action.point, skipLeafAutoSkip);
}
function applyMinimaxAction(engine, action, skipLeafAutoSkip = false) {
  return applySearchAction(engine, action, skipLeafAutoSkip);
}
function reachTopology(engine) {
  let topology = reachTopologies.get(engine);
  if (topology?.positions === engine.validPositions && topology.adjacencyMethod === engine.getAdjacentPositions) return topology;
  const positions = engine.validPositions;
  const indices = new Map(positions.map((point, index) => [pointKey2(point), index]));
  topology = {
    positions,
    adjacencyMethod: engine.getAdjacentPositions,
    adjacent: positions.map((point) => engine.getAdjacentPositions(point).map((neighbor) => indices.get(pointKey2(neighbor))).filter((index) => index !== void 0)),
    visited: new Uint8Array(positions.length),
    blocked: new Uint8Array(positions.length),
    frontier: new Int32Array(positions.length)
  };
  reachTopologies.set(engine, topology);
  return topology;
}
function fastTerritoryBFS(engine, player) {
  const myStates = engine._getPlayerStates(player);
  const opponentStates = /* @__PURE__ */ new Set();
  for (const opponent of getOpponents(engine, player)) {
    const states = engine._getPlayerStates(opponent);
    opponentStates.add(states.node);
    opponentStates.add(states.line);
  }
  const { positions, adjacent, frontier, visited, blocked } = reachTopology(engine);
  visited.fill(0);
  let length = 0;
  for (let index = 0; index < positions.length; index += 1) {
    const point = positions[index];
    const state = engine._getState(point);
    blocked[index] = opponentStates.has(state) ? 1 : 0;
    if (state === myStates.node || state === myStates.line) {
      visited[index] = 1;
      frontier[length++] = index;
    }
  }
  for (let index = 0; index < length; index += 1) {
    for (const neighbor of adjacent[frontier[index]]) {
      if (!visited[neighbor] && !blocked[neighbor]) {
        visited[neighbor] = 1;
        frontier[length++] = neighbor;
      }
    }
  }
  return length;
}
function evaluate(engine, player) {
  const opponents = getOpponents(engine, player);
  const myNodes = engine._getPlayerNodes(player);
  const myLines = engine._getPlayerLines(player);
  let opponentNodeCount = 0;
  let opponentLineCount = 0;
  const opponentLines = [];
  let mainOpponent = null;
  let mainOpponentNodeCount = -1;
  for (const opponent of opponents) {
    const nodes = engine._getPlayerNodes(opponent);
    const lines = engine._getPlayerLines(opponent);
    opponentNodeCount += nodes.length;
    opponentLineCount += lines.length;
    opponentLines.push(...lines);
    if (nodes.length > mainOpponentNodeCount) {
      mainOpponent = opponent;
      mainOpponentNodeCount = nodes.length;
    }
  }
  const nodeAdvantage = myNodes.length - opponentNodeCount;
  const coverageAdvantage = myNodes.length + myLines.length - opponentNodeCount - opponentLineCount;
  const territoryAdvantage = fastTerritoryBFS(engine, player) - (mainOpponent === null ? 0 : fastTerritoryBFS(engine, mainOpponent));
  const attackThreats = opponentLines.reduce(
    (count, point) => count + (engine._evaluateMove(point, player).legal ? 1 : 0),
    0
  );
  const connectionQuality = myNodes.reduce(
    (score, node) => score + (engine._isConnectedToInitial(node, player) ? 1 : -1),
    0
  );
  return 15 * nodeAdvantage + 8 * coverageAdvantage + 20 * territoryAdvantage + 12 * attackThreats + 10 * connectionQuality;
}
function orderMoves(engine, moves, player) {
  const ownLine = engine._getPlayerStates(player).line;
  const opponentLines = new Set(
    getOpponents(engine, player).map(
      (opponent) => engine._getPlayerStates(opponent).line
    )
  );
  const tiers = [[], [], []];
  for (const point of moves) {
    if (opponentLines.has(engine._getState(point))) {
      tiers[0].push(point);
    } else if (engine.getAdjacentPositions(point).some((adjacent) => engine._getState(adjacent) === ownLine)) {
      tiers[1].push(point);
    } else {
      tiers[2].push(point);
    }
  }
  return [...tiers[0], ...tiers[1], ...tiers[2]].slice(0, 20);
}
function materialKeys(engine, player) {
  const nodes = new Set(engine._getPlayerNodes(player).map(pointKey2));
  const coverage = new Set(nodes);
  for (const line of engine._getPlayerLines(player)) coverage.add(pointKey2(line));
  return { nodes, coverage };
}
function lostKeys(before, after) {
  return new Set([...before].filter((key3) => !after.has(key3)));
}
function weightedLoss(nodes, coverage) {
  return MINIMAX_WEIGHTS.lostNodes * nodes.size + MINIMAX_WEIGHTS.lostCoverage * coverage.size;
}
function cutAnalysis(engine, defender) {
  const before = materialKeys(engine, defender);
  const lines = engine._getPlayerLines(defender);
  const threats = /* @__PURE__ */ new Map();
  for (const attacker of getOpponents(engine, defender)) {
    const sourceNodes = engine._getPlayerNodes(attacker);
    for (const point of lines) {
      if (!engine._evaluateMove(point, attacker, sourceNodes).legal) continue;
      const snapshot = saveState(engine);
      try {
        engine.currentPlayer = attacker;
        if (!engine._addNode(point, sourceNodes)) continue;
        const after = materialKeys(engine, defender);
        const lostNodes = lostKeys(before.nodes, after.nodes);
        const lostCoverage = lostKeys(before.coverage, after.coverage);
        const loss = weightedLoss(lostNodes, lostCoverage);
        const key3 = pointKey2(point);
        const previous = threats.get(key3);
        if (!previous || loss > previous.loss) {
          threats.set(key3, {
            attacker,
            point: [...point],
            loss,
            lostNodes,
            lostCoverage
          });
        }
      } finally {
        restoreState(engine, snapshot);
      }
    }
  }
  const damaging = [...threats.values()].filter(({ loss }) => loss > 0);
  const primary = damaging.reduce((best, threat) => !best || threat.loss > best.loss ? threat : best, null);
  const immediate = primary?.loss ?? 0;
  return { threats, immediate };
}
function cutThreats(engine, defender) {
  return new Map([...cutAnalysis(engine, defender).threats].map(([key3, threat]) => [key3, threat.loss]));
}
function materialCounts(engine, player) {
  const material = materialKeys(engine, player);
  return { nodes: material.nodes.size, coverage: material.coverage.size };
}
function materialLoss(engine, player, reference) {
  const remaining = materialCounts(engine, player);
  return {
    nodes: Math.max(0, reference.nodes - remaining.nodes),
    coverage: Math.max(0, reference.coverage - remaining.coverage)
  };
}
function survivingPlayers(engine) {
  return engine.activePlayers.filter((player) => !engine.resignedPlayers.has(player));
}
function comparePersistentLoss(left, right) {
  return left.nodes - right.nodes || left.coverage - right.coverage;
}
function boundedRootCutChainRisk(engine, defender, check2 = null) {
  const remainingPlayers = survivingPlayers(engine);
  if (remainingPlayers.length !== 2 || !remainingPlayers.includes(defender)) return null;
  if (engine.gameOver || engine.currentPlayer === defender) {
    return { nodes: 0, coverage: 0, firstCuts: 0, responses: 0, transitions: 0 };
  }
  const reference = materialCounts(engine, defender);
  const origin = saveState(engine);
  const budget = { firstCuts: 0, responses: 0, transitions: 0 };
  const spendTransition = /* @__PURE__ */ __name(() => {
    check2?.();
    budget.transitions += 1;
    if (budget.transitions > ROOT_CUT_CHAIN_LIMITS.maxTransitions) {
      throw ROOT_CUT_CHAIN_LIMIT_REACHED;
    }
  }, "spendTransition");
  let worstFirst = { nodes: 0, coverage: 0 };
  try {
    const firstPoints = engine._getPlayerLines(defender).map((point) => [...point]);
    for (const firstPoint of firstPoints) {
      const beforeFirst = saveState(engine);
      try {
        spendTransition();
        if (!engine.playMove(firstPoint).success) continue;
        const firstLoss = materialLoss(engine, defender, reference);
        if (firstLoss.nodes === 0 && firstLoss.coverage === 0) continue;
        budget.firstCuts += 1;
        if (budget.firstCuts > ROOT_CUT_CHAIN_LIMITS.maxFirstCuts) {
          throw ROOT_CUT_CHAIN_LIMIT_REACHED;
        }
        let responses;
        if (engine.gameOver || engine.currentPlayer !== defender) {
          responses = [null];
        } else {
          const sourceNodes = engine._getPlayerNodes(defender);
          const potentialResponses = engine.validPositions.reduce((count, point) => count + (sourceNodes.some((node) => engine.canConnectWithBlocking(point, node, defender)) ? 1 : 0), 0);
          if (potentialResponses > ROOT_CUT_CHAIN_LIMITS.maxPotentialResponses) {
            throw ROOT_CUT_CHAIN_LIMIT_REACHED;
          }
          const legal = engine.getLegalMoves(defender).map(({ point }) => [...point]);
          responses = [...legal, "PASS"];
          if (responses.length > ROOT_CUT_CHAIN_LIMITS.maxResponsesPerCut) {
            throw ROOT_CUT_CHAIN_LIMIT_REACHED;
          }
        }
        budget.responses += responses.length;
        let bestResponse = null;
        for (const response of responses) {
          const beforeResponse = saveState(engine);
          try {
            if (response === "PASS") {
              spendTransition();
              if (!engine.skipTurn().success) continue;
            } else if (response !== null) {
              spendTransition();
              if (!engine.playMove(response).success) continue;
            }
            let worstSecond = materialLoss(engine, defender, reference);
            if (!engine.gameOver && engine.currentPlayer !== defender) {
              const secondPoints = engine._getPlayerLines(defender).map((point) => [...point]);
              for (const secondPoint of secondPoints) {
                const beforeSecond = saveState(engine);
                try {
                  spendTransition();
                  if (!engine.playMove(secondPoint).success) continue;
                  const secondLoss = materialLoss(engine, defender, reference);
                  if (comparePersistentLoss(secondLoss, worstSecond) > 0) {
                    worstSecond = secondLoss;
                  }
                } finally {
                  restoreState(engine, beforeSecond);
                }
              }
            }
            if (bestResponse === null || comparePersistentLoss(worstSecond, bestResponse) < 0) {
              bestResponse = worstSecond;
            }
          } finally {
            restoreState(engine, beforeResponse);
          }
        }
        if (bestResponse !== null && comparePersistentLoss(bestResponse, worstFirst) > 0) {
          worstFirst = bestResponse;
        }
      } finally {
        restoreState(engine, beforeFirst);
      }
    }
    return { ...worstFirst, ...budget };
  } catch (error) {
    if (error === ROOT_CUT_CHAIN_LIMIT_REACHED) return null;
    throw error;
  } finally {
    restoreState(engine, origin);
  }
}
function boundedRootCutChainAttack(engine, attacker, defenderReference, check2 = null) {
  const remainingPlayers = survivingPlayers(engine);
  if (remainingPlayers.length !== 2 || !remainingPlayers.includes(attacker)) return null;
  const defender = remainingPlayers.find((player) => player !== attacker);
  if (!defender || !defenderReference) return null;
  const origin = saveState(engine);
  const budget = { responses: 0, secondCuts: 0, transitions: 0 };
  const spendTransition = /* @__PURE__ */ __name(() => {
    check2?.();
    budget.transitions += 1;
    if (budget.transitions > ROOT_CUT_CHAIN_LIMITS.maxTransitions) {
      throw ROOT_CUT_CHAIN_LIMIT_REACHED;
    }
  }, "spendTransition");
  try {
    if (engine.gameOver) {
      return { ...materialLoss(engine, defender, defenderReference), ...budget };
    }
    let responses;
    if (engine.currentPlayer === attacker) {
      responses = [null];
    } else if (engine.currentPlayer === defender) {
      const sourceNodes = engine._getPlayerNodes(defender);
      const potentialResponses = engine.validPositions.reduce((count, point) => count + (sourceNodes.some((node) => engine.canConnectWithBlocking(point, node, defender)) ? 1 : 0), 0);
      if (potentialResponses > ROOT_CUT_CHAIN_LIMITS.maxPotentialResponses) {
        throw ROOT_CUT_CHAIN_LIMIT_REACHED;
      }
      const legal = engine.getLegalMoves(defender).map(({ point }) => [...point]);
      responses = [...legal, "PASS"];
      if (responses.length > ROOT_CUT_CHAIN_LIMITS.maxResponsesPerCut) {
        throw ROOT_CUT_CHAIN_LIMIT_REACHED;
      }
    } else {
      return null;
    }
    budget.responses += responses.length;
    let forcedLoss = null;
    for (const response of responses) {
      const beforeResponse = saveState(engine);
      try {
        if (response === "PASS") {
          spendTransition();
          if (!engine.skipTurn().success) continue;
        } else if (response !== null) {
          spendTransition();
          if (!engine.playMove(response).success) continue;
        }
        let bestContinuation = materialLoss(engine, defender, defenderReference);
        if (!engine.gameOver && engine.currentPlayer === attacker) {
          const secondPoints = engine._getPlayerLines(defender).map((point) => [...point]);
          for (const secondPoint of secondPoints) {
            const beforeSecond = saveState(engine);
            try {
              spendTransition();
              if (!engine.playMove(secondPoint).success) continue;
              const secondLoss = materialLoss(engine, defender, defenderReference);
              if (comparePersistentLoss(secondLoss, bestContinuation) > 0) {
                bestContinuation = secondLoss;
              }
              budget.secondCuts += 1;
            } finally {
              restoreState(engine, beforeSecond);
            }
          }
        }
        if (forcedLoss === null || comparePersistentLoss(bestContinuation, forcedLoss) < 0) {
          forcedLoss = bestContinuation;
        }
      } finally {
        restoreState(engine, beforeResponse);
      }
    }
    return forcedLoss === null ? null : { ...forcedLoss, ...budget };
  } catch (error) {
    if (error === ROOT_CUT_CHAIN_LIMIT_REACHED) return null;
    throw error;
  } finally {
    restoreState(engine, origin);
  }
}
function applyRootCutChainPreference(engine, player, scoredMoves, eligibleKeys, check2 = null) {
  const remainingPlayers = survivingPlayers(engine);
  if (remainingPlayers.length !== 2 || !remainingPlayers.includes(player)) return scoredMoves;
  if (!scoredMoves.length || scoredMoves[0].point === null) return scoredMoves;
  const window = scoredMoves.filter(({ point }) => point !== null && eligibleKeys.has(pointKey2(point))).slice(0, ROOT_CUT_CHAIN_LIMITS.rankingWidth);
  if (!window.length || pointKey2(window[0].point) !== pointKey2(scoredMoves[0].point)) {
    return scoredMoves;
  }
  const opponent = remainingPlayers.find((candidate) => candidate !== player);
  const opponentReference = materialCounts(engine, opponent);
  const comparisons = /* @__PURE__ */ new Map();
  for (const move of window) {
    check2?.();
    const snapshot = saveState(engine);
    try {
      if (!engine.playMove(move.point).success) return scoredMoves;
      if (engine.gameOver || engine.currentPlayer === player) continue;
      const risk = boundedRootCutChainRisk(engine, player, check2);
      if (risk === null) continue;
      const attack = boundedRootCutChainAttack(engine, player, opponentReference, check2);
      if (attack === null) continue;
      comparisons.set(pointKey2(move.point), {
        risk,
        attack,
        netNodeGain: attack.nodes - risk.nodes
      });
    } finally {
      restoreState(engine, snapshot);
    }
  }
  const topKey = pointKey2(scoredMoves[0].point);
  const top = comparisons.get(topKey);
  if (!top) return scoredMoves;
  const dominant = window.filter((move) => {
    const comparison = comparisons.get(pointKey2(move.point));
    if (!comparison) return false;
    const riskComparison = comparePersistentLoss(comparison.risk, top.risk);
    const attackComparison = comparePersistentLoss(comparison.attack, top.attack);
    const defensiveDominance = comparison.netNodeGain >= top.netNodeGain && riskComparison < 0;
    const offensiveDominance = riskComparison <= 0 && attackComparison > 0;
    return defensiveDominance || offensiveDominance;
  });
  if (!dominant.length) return scoredMoves;
  dominant.sort((left, right) => {
    const leftComparison = comparisons.get(pointKey2(left.point));
    const rightComparison = comparisons.get(pointKey2(right.point));
    return rightComparison.netNodeGain - leftComparison.netNodeGain || comparePersistentLoss(rightComparison.attack, leftComparison.attack) || comparePersistentLoss(leftComparison.risk, rightComparison.risk) || window.indexOf(left) - window.indexOf(right);
  });
  const preferred = dominant[0];
  const preferredIndex = scoredMoves.indexOf(preferred);
  scoredMoves.splice(preferredIndex, 1);
  scoredMoves.unshift(preferred);
  return scoredMoves;
}
function opponentRiskMaterial(engine, player) {
  return getOpponents(engine, player).reduce((total, opponent) => {
    const nodes = engine._getPlayerNodes(opponent).length;
    const coverage = nodes + engine._getPlayerLines(opponent).length;
    return total + MINIMAX_WEIGHTS.lostNodes * nodes + MINIMAX_WEIGHTS.lostCoverage * coverage;
  }, 0);
}
function immediateRiskPenalty(engine, player, previousOpponentMaterial) {
  if (engine.gameOver || engine.currentPlayer === player) return 0;
  const capturedMaterial = Math.max(
    0,
    previousOpponentMaterial - opponentRiskMaterial(engine, player)
  );
  const pressure = cutAnalysis(engine, player).immediate;
  return Math.max(0, pressure - capturedMaterial);
}
function evaluateMinimax(engine, player) {
  const opponents = getOpponents(engine, player);
  const myNodes = engine._getPlayerNodes(player);
  const myLines = engine._getPlayerLines(player);
  let opponentNodes = 0;
  let opponentCoverage = 0;
  let mainOpponent = null;
  let mainOpponentNodes = -1;
  let attacks = 0;
  for (const opponent of opponents) {
    const nodes = engine._getPlayerNodes(opponent);
    const lines = engine._getPlayerLines(opponent);
    opponentNodes += nodes.length;
    opponentCoverage += nodes.length + lines.length;
    if (nodes.length > mainOpponentNodes) {
      mainOpponent = opponent;
      mainOpponentNodes = nodes.length;
    }
    for (const point of lines) {
      if (engine._evaluateMove(point, player, myNodes).legal) attacks += 1;
    }
  }
  const reach = fastTerritoryBFS(engine, player) - (mainOpponent === null ? 0 : fastTerritoryBFS(engine, mainOpponent));
  const defensivePressure = cutAnalysis(engine, player).immediate;
  return MINIMAX_WEIGHTS.nodes * (myNodes.length - opponentNodes) + MINIMAX_WEIGHTS.coverage * (myNodes.length + myLines.length - opponentCoverage) + MINIMAX_WEIGHTS.reachableSpace * reach + MINIMAX_WEIGHTS.attackOpportunity * attacks - defensivePressure;
}
function orderMinimaxMoves(engine, moves, player) {
  const threats = cutThreats(engine, player);
  const ownLine = engine._getPlayerStates(player).line;
  const enemyLines = new Set(getOpponents(engine, player).map((opponent) => engine._getPlayerStates(opponent).line));
  return moves.map((point, index) => {
    const defense = threats.get(pointKey2(point)) ?? 0;
    const tier = defense >= MINIMAX_WEIGHTS.lostNodes ? 0 : enemyLines.has(engine._getState(point)) ? 1 : engine.getAdjacentPositions(point).some((adjacent) => engine._getState(adjacent) === ownLine) ? 2 : 3;
    return { point, index, defense, tier };
  }).sort((left, right) => left.tier - right.tier || right.defense - left.defense || left.index - right.index).slice(0, 20).map(({ point }) => point);
}
function minimaxTerminalWinner(engine) {
  const winnerMethod = engine.getWinner;
  if (!nativeWinnerMethods.has(winnerMethod)) {
    nativeWinnerMethods.set(winnerMethod, winnerMethod === GameEngine.prototype.getWinner || Function.prototype.toString.call(winnerMethod) === Function.prototype.toString.call(GameEngine.prototype.getWinner));
  }
  if (engine.rulesVersion !== "territory-v3" || !engine.hasPendingTerritoryUpdate() || !nativeWinnerMethods.get(winnerMethod)) return engine.getWinner();
  const owned = new Map(engine.activePlayers.map((player) => [
    player,
    [...engine._getPlayerNodes(player), ...engine._getPlayerLines(player)]
  ]));
  const alive = engine.activePlayers.filter((player) => !engine.resignedPlayers.has(player));
  let bestArea = Number.NEGATIVE_INFINITY, winner = null, draw = false;
  for (const player of alive.length ? alive : engine.activePlayers) {
    const enemies = getOpponents(engine, player).flatMap((opponent) => owned.get(opponent));
    const area = engine._computeOwnedWallArea(owned.get(player), enemies);
    if (area > bestArea) {
      bestArea = area;
      winner = player;
      draw = false;
    } else if (area === bestArea) draw = true;
  }
  return draw ? "DRAW" : winner;
}
var cloneValue, reachTopologies, MINIMAX_WEIGHTS, ROOT_CUT_CHAIN_LIMITS, ROOT_CUT_CHAIN_LIMIT_REACHED, MINIMAX_EXTENSION_EXPIRED, LARGE_DIAMOND_HARD_MIN_GRID_SIZE, LARGE_DIAMOND_HARD_TOTAL_TIME_MS, nativeWinnerMethods, MinimaxAI, GreedyAI, MCTSAI;
var init_RootModeSearch = __esm({
  "application-hard:RootModeSearch.js"() {
    init_GameEngine();
    cloneValue = /* @__PURE__ */ __name((value) => JSON.parse(JSON.stringify(value)), "cloneValue");
    __name(pointKey2, "pointKey");
    __name(getOpponents, "getOpponents");
    __name(cloneCachedTerritories, "cloneCachedTerritories");
    __name(saveState, "saveState");
    __name(restoreState, "restoreState");
    __name(applyMoveForAI, "applyMoveForAI");
    __name(isRootSearchAction, "isRootSearchAction");
    __name(cloneSearchAction, "cloneSearchAction");
    __name(searchActionKey, "searchActionKey");
    __name(legalSearchActions, "legalSearchActions");
    __name(applySearchAction, "applySearchAction");
    __name(applyMinimaxAction, "applyMinimaxAction");
    reachTopologies = /* @__PURE__ */ new WeakMap();
    __name(reachTopology, "reachTopology");
    __name(fastTerritoryBFS, "fastTerritoryBFS");
    __name(evaluate, "evaluate");
    __name(orderMoves, "orderMoves");
    MINIMAX_WEIGHTS = Object.freeze({
      nodes: 30,
      coverage: 4,
      reachableSpace: 4,
      attackOpportunity: 4,
      // Potential loss is discounted relative to material already lost. A cut
      // must never become attractive merely because it clears a risk penalty.
      lostNodes: 24,
      lostCoverage: 3,
      // Extra preference for avoiding an uncompensated cut on the next turn.
      // This is a conservative root choice, in addition to the searched value.
      rootRiskAversion: 1.5
    });
    __name(materialKeys, "materialKeys");
    __name(lostKeys, "lostKeys");
    __name(weightedLoss, "weightedLoss");
    __name(cutAnalysis, "cutAnalysis");
    __name(cutThreats, "cutThreats");
    ROOT_CUT_CHAIN_LIMITS = Object.freeze({
      rankingWidth: 4,
      maxFirstCuts: 4,
      maxPotentialResponses: 40,
      maxResponsesPerCut: 24,
      maxTransitions: 512
    });
    ROOT_CUT_CHAIN_LIMIT_REACHED = Symbol("ROOT_CUT_CHAIN_LIMIT_REACHED");
    __name(materialCounts, "materialCounts");
    __name(materialLoss, "materialLoss");
    __name(survivingPlayers, "survivingPlayers");
    __name(comparePersistentLoss, "comparePersistentLoss");
    __name(boundedRootCutChainRisk, "boundedRootCutChainRisk");
    __name(boundedRootCutChainAttack, "boundedRootCutChainAttack");
    __name(applyRootCutChainPreference, "applyRootCutChainPreference");
    __name(opponentRiskMaterial, "opponentRiskMaterial");
    __name(immediateRiskPenalty, "immediateRiskPenalty");
    __name(evaluateMinimax, "evaluateMinimax");
    __name(orderMinimaxMoves, "orderMinimaxMoves");
    MINIMAX_EXTENSION_EXPIRED = Symbol("Minimax optional deeper iteration expired");
    LARGE_DIAMOND_HARD_MIN_GRID_SIZE = 9;
    LARGE_DIAMOND_HARD_TOTAL_TIME_MS = 11e3;
    nativeWinnerMethods = /* @__PURE__ */ new WeakMap();
    __name(minimaxTerminalWinner, "minimaxTerminalWinner");
    MinimaxAI = class {
      static {
        __name(this, "MinimaxAI");
      }
      constructor(depth = 3, {
        rootPruning = true,
        moveOrdering = true,
        iterativeDeepening = false,
        extensionTimeMs = 100,
        maxExtraDepth = 2,
        now: now2 = /* @__PURE__ */ __name(() => performance.now(), "now")
      } = {}) {
        if (!Number.isFinite(extensionTimeMs) || !(extensionTimeMs > 0) || !Number.isInteger(maxExtraDepth) || maxExtraDepth < 0 || maxExtraDepth > 2 || typeof now2 !== "function") {
          throw new Error("Invalid Minimax deeper-search settings");
        }
        this.depth = depth;
        this.rootPruning = rootPruning;
        this.moveOrdering = moveOrdering;
        Object.assign(this, { iterativeDeepening, extensionTimeMs, maxExtraDepth, now: now2 });
        this.lastSearch = null;
      }
      checkSearchBudget() {
        if (this._searchDeadline !== void 0) {
          const time = this.searchTime();
          if (time >= this._searchDeadline) throw MINIMAX_EXTENSION_EXPIRED;
        }
      }
      searchTime() {
        const time = this.now();
        if (!Number.isFinite(time)) throw new Error("Invalid Minimax search clock");
        return time;
      }
      getLegalMoves(engine, player) {
        return engine.getLegalMoves(player).map((move) => move.point);
      }
      getLegalActions(engine, player) {
        return legalSearchActions(engine, player);
      }
      orderMoves(engine, moves, player) {
        return orderMinimaxMoves(engine, moves, player);
      }
      evaluate(engine, player) {
        if (engine.gameOver) {
          const winner = minimaxTerminalWinner(engine);
          if (winner === "DRAW") return 0;
          return winner === player ? 1e6 : -1e6;
        }
        return evaluateMinimax(engine, player);
      }
      minimax(engine, depth, alpha, beta, aiPlayer) {
        this.checkSearchBudget();
        if (this._searchStats) this._searchStats.nodes += 1;
        if (engine.gameOver || depth === 0) {
          if (this._searchStats) this._searchStats.leaves += 1;
          return this.evaluate(engine, aiPlayer);
        }
        const legalActions = this.getLegalActions(engine, engine.currentPlayer);
        const placements = legalActions.filter(Array.isArray);
        const rootActions = legalActions.filter(isRootSearchAction);
        const ordered = [...this.orderMoves(engine, placements, engine.currentPlayer), ...rootActions];
        const actions = [...ordered, null];
        const killers = this._killerMoves?.get(depth);
        if (killers?.length) {
          const priority = /* @__PURE__ */ __name((action) => {
            const index = killers.indexOf(action === null ? "PASS" : searchActionKey(action));
            return index < 0 ? killers.length : index;
          }, "priority");
          actions.sort((left, right) => priority(left) - priority(right));
        }
        const rememberCutoff = /* @__PURE__ */ __name((action) => {
          if (!this._killerMoves) return;
          const key3 = action === null ? "PASS" : searchActionKey(action);
          const previous = this._killerMoves.get(depth) ?? [];
          this._killerMoves.set(depth, [key3, ...previous.filter((entry) => entry !== key3)].slice(0, 2));
        }, "rememberCutoff");
        const maximizingPlayer = engine.currentPlayer === aiPlayer;
        if (maximizingPlayer) {
          let bestValue2 = Number.NEGATIVE_INFINITY;
          for (const action of actions) {
            const snapshot = saveState(engine);
            try {
              const applied = applyMinimaxAction(engine, action, depth === 1);
              if (applied) {
                const value = this.minimax(engine, depth - 1, alpha, beta, aiPlayer);
                bestValue2 = Math.max(bestValue2, value);
                alpha = Math.max(alpha, bestValue2);
              }
            } finally {
              restoreState(engine, snapshot);
            }
            if (beta <= alpha) {
              if (this._searchStats) this._searchStats.cutoffs += 1;
              rememberCutoff(action);
              break;
            }
          }
          return bestValue2;
        }
        let bestValue = Number.POSITIVE_INFINITY;
        for (const action of actions) {
          const snapshot = saveState(engine);
          try {
            const applied = applyMinimaxAction(engine, action, depth === 1);
            if (applied) {
              const value = this.minimax(engine, depth - 1, alpha, beta, aiPlayer);
              bestValue = Math.min(bestValue, value);
              beta = Math.min(beta, bestValue);
            }
          } finally {
            restoreState(engine, snapshot);
          }
          if (beta <= alpha) {
            if (this._searchStats) this._searchStats.cutoffs += 1;
            rememberCutoff(action);
            break;
          }
        }
        return bestValue;
      }
      getTopMoves(engine, aiPlayer, topN = 5, options = {}) {
        if (Number.isFinite(options.deadline)) {
          const previousDeadline2 = this._searchDeadline;
          const fallback = this.getLegalActions(engine, aiPlayer)[0];
          if (!fallback) return [];
          this._searchDeadline = options.deadline;
          try {
            const result = this.searchAtDepth(engine, aiPlayer, topN);
            this.lastSearch = { ...this.lastSearch, requestedDepth: this.depth, completedDepth: this.depth, partial: false };
            return result;
          } catch (error) {
            if (error !== MINIMAX_EXTENSION_EXPIRED) throw error;
            this.lastSearch = { requestedDepth: this.depth, completedDepth: 0, partial: true, decisionSource: "legal-fallback" };
            return [{
              point: Array.isArray(fallback) ? fallback : fallback.point,
              ...isRootSearchAction(fallback) ? { type: fallback.type } : {},
              score: null
            }].slice(0, topN);
          } finally {
            this._searchDeadline = previousDeadline2;
          }
        }
        if (this.depth === 4 && engine.playerCount === 2 && engine.boardShape === "diamond" && engine.gridSize >= LARGE_DIAMOND_HARD_MIN_GRID_SIZE && engine.rootMode === "classic") {
          return this.getLargeDiamondHardMoves(engine, aiPlayer, topN);
        }
        const base = this.searchAtDepth(engine, aiPlayer, topN);
        if (!this.iterativeDeepening || this.depth < 4 || !base.length || engine.gameOver || survivingPlayers(engine).length !== 2 || engine.validPositions.length > 55 || this.maxExtraDepth === 0) return base;
        const baseDepth = this.depth, baseStats = this.lastSearch;
        const previousDeadline = this._searchDeadline;
        const started = this.searchTime();
        this._searchDeadline = started + this.extensionTimeMs;
        let moves = base, completedDepth = baseDepth, interrupted = false;
        const iterations = [];
        try {
          for (let extra = 1; extra <= this.maxExtraDepth; extra += 1) {
            this.depth = baseDepth + extra;
            let iterationStarted = false;
            try {
              this.checkSearchBudget();
              iterationStarted = true;
              const deeper = this.searchAtDepth(engine, aiPlayer, topN);
              this.checkSearchBudget();
              iterations.push({ ...this.lastSearch, complete: true });
              moves = deeper;
              completedDepth = this.depth;
            } catch (error) {
              if (error !== MINIMAX_EXTENSION_EXPIRED) throw error;
              iterations.push({
                ...iterationStarted ? this.lastSearch : { nodes: 0, leaves: 0, cutoffs: 0, rootActions: 0 },
                depth: this.depth,
                complete: false
              });
              interrupted = true;
              break;
            }
          }
          return moves;
        } finally {
          this.depth = baseDepth;
          this._searchDeadline = previousDeadline;
          this.lastSearch = {
            ...baseStats,
            depth: completedDepth,
            baseDepth,
            iterativeDeepening: true,
            extensionTimeMs: this.extensionTimeMs,
            extensionElapsedMs: this.searchTime() - started,
            extensionInterrupted: interrupted,
            completedDepth,
            deeperIterations: iterations
          };
        }
      }
      getLargeDiamondHardMoves(engine, aiPlayer, topN) {
        const requestedDepth = this.depth;
        const baseDepth = 2;
        const previousDeadline = this._searchDeadline;
        const started = this.searchTime();
        const totalDeadline = started + LARGE_DIAMOND_HARD_TOTAL_TIME_MS;
        const iterations = [];
        let completedStats = null;
        let completedDepth = baseDepth;
        let interrupted = false;
        let moves = [];
        try {
          this.depth = baseDepth;
          this._searchDeadline = void 0;
          moves = this.searchAtDepth(engine, aiPlayer, topN);
          completedStats = { ...this.lastSearch };
          if (!moves.length || engine.gameOver) return moves;
          for (let depth = baseDepth + 1; depth <= requestedDepth; depth += 1) {
            this.depth = depth;
            this._searchDeadline = totalDeadline;
            try {
              const candidate = this.searchAtDepth(engine, aiPlayer, topN);
              const attemptStats = { ...this.lastSearch };
              this.checkSearchBudget();
              moves = candidate;
              completedDepth = depth;
              completedStats = attemptStats;
              iterations.push({ ...attemptStats, depth, complete: true });
            } catch (error) {
              const attemptStats = { ...this.lastSearch };
              if (error !== MINIMAX_EXTENSION_EXPIRED) throw error;
              iterations.push({ ...attemptStats, depth, complete: false });
              interrupted = true;
              break;
            }
          }
          return moves;
        } finally {
          this.depth = requestedDepth;
          this._searchDeadline = previousDeadline;
          const elapsedMs = this.searchTime() - started;
          this.lastSearch = {
            ...completedStats ?? this.lastSearch ?? {},
            depth: completedDepth,
            requestedDepth,
            completedDepth,
            baseDepth,
            iterativeDeepening: true,
            largeDiamondGuard: true,
            totalBudgetMs: LARGE_DIAMOND_HARD_TOTAL_TIME_MS,
            elapsedMs,
            extensionInterrupted: interrupted,
            deeperIterations: iterations
          };
        }
      }
      searchAtDepth(engine, aiPlayer, topN) {
        const previousReplayFlag = engine._isReplayingBatch;
        const previousSearchStats = this._searchStats;
        const previousKillerMoves = this._killerMoves;
        const stats = {
          depth: this.depth,
          nodes: 0,
          leaves: 0,
          cutoffs: 0,
          rootActions: 0,
          exactRoots: 0,
          prunedRoots: 0,
          rootPruning: this.rootPruning,
          moveOrdering: this.moveOrdering
        };
        this._searchStats = stats;
        this._killerMoves = this.moveOrdering ? /* @__PURE__ */ new Map() : null;
        engine._isReplayingBatch = true;
        try {
          this.checkSearchBudget();
          const legalActions = this.getLegalActions(engine, aiPlayer);
          const placements = legalActions.filter(Array.isArray);
          const rootActions = legalActions.filter(isRootSearchAction);
          const ordered = [...this.orderMoves(engine, placements, aiPlayer), ...rootActions];
          this.checkSearchBudget();
          const rootCutChainEligible = new Set(ordered.filter(Array.isArray).map(pointKey2));
          const previousOpponentMaterial = this.depth > 1 ? opponentRiskMaterial(engine, aiPlayer) : 0;
          const scoredMoves = [];
          const retainedRoots = this.rootPruning && Number.isFinite(topN) && topN > 0 ? Math.max(ROOT_CUT_CHAIN_LIMITS.rankingWidth + 1, Math.ceil(topN) + 1) : Number.POSITIVE_INFINITY;
          for (const action of [...ordered, null]) {
            this.checkSearchBudget();
            stats.rootActions += 1;
            const snapshot = saveState(engine);
            try {
              const applied = applyMinimaxAction(engine, action, this.depth <= 1);
              if (applied) {
                const immediateRisk = this.depth > 1 ? immediateRiskPenalty(engine, aiPlayer, previousOpponentMaterial) : 0;
                this.checkSearchBudget();
                const riskPenalty = MINIMAX_WEIGHTS.rootRiskAversion * immediateRisk;
                const threshold = scoredMoves.length >= retainedRoots ? scoredMoves[retainedRoots - 1].score : Number.NEGATIVE_INFINITY;
                const score = this.minimax(
                  engine,
                  this.depth - 1,
                  threshold + riskPenalty,
                  Number.POSITIVE_INFINITY,
                  aiPlayer
                ) - riskPenalty;
                if (Number.isFinite(threshold) && score <= threshold) {
                  stats.prunedRoots += 1;
                  continue;
                }
                stats.exactRoots += 1;
                const point = action === null ? null : Array.isArray(action) ? action : action.point;
                scoredMoves.push({
                  point,
                  ...action === null ? { type: "pass" } : isRootSearchAction(action) ? { type: action.type } : {},
                  score
                });
                if (Number.isFinite(retainedRoots)) {
                  scoredMoves.sort((a, b) => b.score - a.score);
                  if (scoredMoves.length > retainedRoots) scoredMoves.length = retainedRoots;
                }
              }
            } finally {
              restoreState(engine, snapshot);
            }
          }
          scoredMoves.sort((a, b) => b.score - a.score);
          if (this.depth > 1) {
            applyRootCutChainPreference(
              engine,
              aiPlayer,
              scoredMoves,
              rootCutChainEligible,
              this._searchDeadline === void 0 ? null : () => this.checkSearchBudget()
            );
          }
          this.checkSearchBudget();
          const selectedPass = scoredMoves[0]?.point === null ? scoredMoves[0] : null;
          const placementMoves = scoredMoves.filter(({ point }) => point !== null);
          return (selectedPass ? [selectedPass, ...placementMoves] : placementMoves).slice(0, topN);
        } finally {
          engine._isReplayingBatch = previousReplayFlag;
          this._searchStats = previousSearchStats;
          this._killerMoves = previousKillerMoves;
          this.lastSearch = stats;
        }
      }
    };
    GreedyAI = class {
      static {
        __name(this, "GreedyAI");
      }
      getLegalMoves(engine, player) {
        return engine.getLegalMoves(player).map((move) => move.point);
      }
      getLegalActions(engine, player) {
        return legalSearchActions(engine, player);
      }
      orderMoves(engine, moves, player) {
        return orderMoves(engine, moves, player);
      }
      getTopMoves(engine, aiPlayer, topN = 5, options = {}) {
        const previousReplayFlag = engine._isReplayingBatch;
        engine._isReplayingBatch = true;
        try {
          const legalActions = this.getLegalActions(engine, aiPlayer);
          if (legalActions.length === 0) {
            return [];
          }
          const placements = legalActions.filter(Array.isArray);
          const ordered = [...this.orderMoves(engine, placements, aiPlayer), ...legalActions.filter(isRootSearchAction)];
          const scoredMoves = [];
          for (const action of ordered) {
            if (Number.isFinite(options.deadline) && performance.now() >= options.deadline && scoredMoves.length) break;
            const snapshot = saveState(engine);
            try {
              const applied = applySearchAction(engine, action, true);
              if (applied) scoredMoves.push({
                point: Array.isArray(action) ? action : action.point,
                ...isRootSearchAction(action) ? { type: action.type } : {},
                score: evaluate(engine, aiPlayer)
              });
            } finally {
              restoreState(engine, snapshot);
            }
          }
          scoredMoves.sort((a, b) => b.score - a.score);
          return scoredMoves.slice(0, topN);
        } finally {
          engine._isReplayingBatch = previousReplayFlag;
        }
      }
    };
    MCTSAI = class {
      static {
        __name(this, "MCTSAI");
      }
      constructor({ simulations = 64, rolloutDepth = 40, exploration = Math.SQRT2, seed = 521288629 } = {}) {
        this.simulations = simulations;
        this.rolloutDepth = rolloutDepth;
        this.exploration = exploration;
        this.seed = seed >>> 0;
      }
      getLegalMoves(engine, player) {
        return engine.getLegalMoves(player).map((move) => move.point);
      }
      getLegalActions(engine, player) {
        return legalSearchActions(engine, player);
      }
      nextRandom() {
        this.seed = Math.imul(this.seed, 1664525) + 1013904223 >>> 0;
        return this.seed / 4294967296;
      }
      selectChild(node, rootPlayer) {
        const logParent = Math.log(Math.max(1, node.visits));
        const actorSign = node.playerToAct === rootPlayer ? 1 : -1;
        let bestScore = Number.NEGATIVE_INFINITY;
        let bestChildren = [];
        for (const child of node.children.values()) {
          const exploitation = actorSign * (child.valueSum / Math.max(1, child.visits));
          const exploration = this.exploration * Math.sqrt(logParent / child.visits);
          const score = exploitation + exploration;
          if (score > bestScore + 1e-12) {
            bestScore = score;
            bestChildren = [child];
          } else if (Math.abs(score - bestScore) <= 1e-12) {
            bestChildren.push(child);
          }
        }
        return bestChildren[Math.floor(this.nextRandom() * bestChildren.length)];
      }
      applyRandomMove(engine, action) {
        return applySearchAction(engine, action, false);
      }
      rollout(engine, rootPlayer, deadline = Infinity) {
        for (let step = 0; step < this.rolloutDepth && !engine.gameOver; step += 1) {
          if (performance.now() >= deadline) break;
          const legalActions = this.getLegalActions(engine, engine.currentPlayer);
          if (!legalActions.length) {
            engine.skipTurn();
            continue;
          }
          const action = legalActions[Math.floor(this.nextRandom() * legalActions.length)];
          if (!this.applyRandomMove(engine, action)) {
            break;
          }
        }
        return Math.tanh(evaluate(engine, rootPlayer) / 100);
      }
      getTopMoves(engine, aiPlayer, topN = 5, options = {}) {
        const previousReplayFlag = engine._isReplayingBatch;
        engine._isReplayingBatch = true;
        try {
          const rootActions = this.getLegalActions(engine, aiPlayer);
          if (!rootActions.length) return [];
          const rootSnapshot = saveState(engine);
          const root = {
            playerToAct: aiPlayer,
            parent: null,
            action: null,
            unexpandedActions: rootActions.map(cloneSearchAction),
            children: /* @__PURE__ */ new Map(),
            visits: 0,
            valueSum: 0
          };
          try {
            for (let simulation = 0; simulation < this.simulations; simulation += 1) {
              if (Number.isFinite(options.deadline) && performance.now() >= options.deadline && simulation > 0) break;
              restoreState(engine, rootSnapshot);
              let node = root;
              while (!engine.gameOver && !node.unexpandedActions.length && node.children.size) {
                node = this.selectChild(node, aiPlayer);
                if (!this.applyRandomMove(engine, node.action)) break;
              }
              if (!engine.gameOver && node.unexpandedActions.length) {
                const index = Math.floor(this.nextRandom() * node.unexpandedActions.length);
                const [action] = node.unexpandedActions.splice(index, 1);
                if (this.applyRandomMove(engine, action)) {
                  const child = {
                    playerToAct: engine.currentPlayer,
                    parent: node,
                    action,
                    unexpandedActions: this.getLegalActions(engine, engine.currentPlayer).map(cloneSearchAction),
                    children: /* @__PURE__ */ new Map(),
                    visits: 0,
                    valueSum: 0
                  };
                  node.children.set(searchActionKey(action), child);
                  node = child;
                }
              }
              const value = this.rollout(engine, aiPlayer, options.deadline);
              for (let cursor = node; cursor; cursor = cursor.parent) {
                cursor.visits += 1;
                cursor.valueSum += value;
              }
            }
          } finally {
            restoreState(engine, rootSnapshot);
          }
          return rootActions.map((action) => {
            const child = root.children.get(searchActionKey(action));
            const visits = child?.visits ?? 0;
            const meanValue = visits ? child.valueSum / visits : 0;
            return {
              point: Array.isArray(action) ? action : action.point,
              ...isRootSearchAction(action) ? { type: action.type } : {},
              score: meanValue,
              visits,
              meanValue
            };
          }).sort((a, b) => b.visits - a.visits || b.meanValue - a.meanValue).slice(0, topN);
        } finally {
          engine._isReplayingBatch = previousReplayFlag;
        }
      }
    };
  }
});

// application-hard:AIEngine.js
function pointKey3(point) {
  return `${point[0]},${point[1]}`;
}
function getOpponents2(engine, player) {
  return engine._getOpponents ? engine._getOpponents(player) : engine.activePlayers.filter((candidate) => candidate !== player);
}
function cloneCachedTerritories2(engine) {
  return Object.fromEntries(
    engine.activePlayers.map((player) => {
      const territory = engine.cachedTerritories[player];
      return [
        player,
        {
          ...territory,
          polygon: territory.polygon ? territory.polygon.map((point) => [...point]) : null,
          ...Array.isArray(territory.renderPoints) ? { renderPoints: territory.renderPoints.map((point) => [...point]) } : {}
        }
      ];
    })
  );
}
function saveState2(engine) {
  return {
    grid: new Map(engine.grid),
    edges: Object.fromEntries(
      engine.activePlayers.map((player) => [player, new Set(engine.edges[player] ?? [])])
    ),
    historyHashes: new Set(engine.historyHashes),
    ...engine.rootRulesVersion === "root-v2" ? {
      roots: Object.fromEntries(engine.activePlayers.map((player) => [player, engine.getRoots(player)])),
      rootActionsRemaining: JSON.parse(JSON.stringify(engine.rootActionsRemaining))
    } : {},
    consecutiveSkips: engine.consecutiveSkips,
    resignedPlayers: new Set(engine.resignedPlayers ?? []),
    currentPlayer: engine.currentPlayer,
    gameOver: engine.gameOver,
    turnCount: engine.turnCount,
    positionRevision: engine.positionRevision ?? 0,
    territoryStateRevision: engine._territoryStateRevision ?? engine.positionRevision ?? 0,
    territoryCacheRevision: engine._territoryCacheRevision ?? engine._territoryStateRevision ?? engine.positionRevision ?? 0,
    cachedTerritories: cloneCachedTerritories2(engine)
  };
}
function restoreState2(engine, snapshot) {
  engine.grid = new Map(snapshot.grid);
  engine.edges = Object.fromEntries(
    engine.activePlayers.map((player) => [player, new Set(snapshot.edges[player] ?? [])])
  );
  engine.historyHashes = new Set(snapshot.historyHashes);
  if (snapshot.roots) {
    engine.roots = Object.fromEntries(engine.activePlayers.map((player) => [player, snapshot.roots[player].map((point) => [...point])]));
    engine.rootActionsRemaining = JSON.parse(JSON.stringify(snapshot.rootActionsRemaining));
  }
  engine.consecutiveSkips = snapshot.consecutiveSkips;
  engine.resignedPlayers = new Set(snapshot.resignedPlayers ?? []);
  engine.currentPlayer = snapshot.currentPlayer;
  engine.gameOver = snapshot.gameOver;
  engine.turnCount = snapshot.turnCount;
  engine.positionRevision = snapshot.positionRevision ?? engine.positionRevision ?? 0;
  engine._territoryStateRevision = snapshot.territoryStateRevision ?? engine.positionRevision;
  engine._territoryCacheRevision = snapshot.territoryCacheRevision ?? engine._territoryStateRevision;
  engine.cachedTerritories = snapshot.cachedTerritories;
}
function applyMoveForAI2(engine, point, skipLeafAutoSkip = false) {
  const originalAutoSkip = skipLeafAutoSkip ? engine._checkAndAutoSkip : null;
  if (skipLeafAutoSkip) {
    engine._checkAndAutoSkip = () => {
    };
  }
  try {
    const result = engine.playMove(point);
    return result.success;
  } finally {
    if (skipLeafAutoSkip) {
      engine._checkAndAutoSkip = originalAutoSkip;
    }
  }
}
function applyMinimaxAction2(engine, point, skipLeafAutoSkip = false) {
  return point === null ? engine.skipTurn().success : applyMoveForAI2(engine, point, skipLeafAutoSkip);
}
function fastTerritoryBFS2(engine, player) {
  const myStates = engine._getPlayerStates(player);
  const opponentStates = /* @__PURE__ */ new Set();
  for (const opponent of getOpponents2(engine, player)) {
    const states = engine._getPlayerStates(opponent);
    opponentStates.add(states.node);
    opponentStates.add(states.line);
  }
  const frontier = [];
  const visited = /* @__PURE__ */ new Set();
  for (const point of engine.validPositions) {
    const state = engine._getState(point);
    if (state === myStates.node || state === myStates.line) {
      const key3 = pointKey3(point);
      visited.add(key3);
      frontier.push(point);
    }
  }
  for (let index = 0; index < frontier.length; index += 1) {
    for (const adjacent of engine.getAdjacentPositions(frontier[index])) {
      const key3 = pointKey3(adjacent);
      if (!visited.has(key3) && !opponentStates.has(engine._getState(adjacent))) {
        visited.add(key3);
        frontier.push(adjacent);
      }
    }
  }
  return visited.size;
}
function evaluate2(engine, player) {
  const opponents = getOpponents2(engine, player);
  const myNodes = engine._getPlayerNodes(player);
  const myLines = engine._getPlayerLines(player);
  let opponentNodeCount = 0;
  let opponentLineCount = 0;
  const opponentLines = [];
  let mainOpponent = null;
  let mainOpponentNodeCount = -1;
  for (const opponent of opponents) {
    const nodes = engine._getPlayerNodes(opponent);
    const lines = engine._getPlayerLines(opponent);
    opponentNodeCount += nodes.length;
    opponentLineCount += lines.length;
    opponentLines.push(...lines);
    if (nodes.length > mainOpponentNodeCount) {
      mainOpponent = opponent;
      mainOpponentNodeCount = nodes.length;
    }
  }
  const nodeAdvantage = myNodes.length - opponentNodeCount;
  const coverageAdvantage = myNodes.length + myLines.length - opponentNodeCount - opponentLineCount;
  const territoryAdvantage = fastTerritoryBFS2(engine, player) - (mainOpponent === null ? 0 : fastTerritoryBFS2(engine, mainOpponent));
  const attackThreats = opponentLines.reduce(
    (count, point) => count + (engine._evaluateMove(point, player).legal ? 1 : 0),
    0
  );
  const connectionQuality = myNodes.reduce(
    (score, node) => score + (engine._isConnectedToInitial(node, player) ? 1 : -1),
    0
  );
  return 15 * nodeAdvantage + 8 * coverageAdvantage + 20 * territoryAdvantage + 12 * attackThreats + 10 * connectionQuality;
}
function orderMoves2(engine, moves, player) {
  const ownLine = engine._getPlayerStates(player).line;
  const opponentLines = new Set(
    getOpponents2(engine, player).map(
      (opponent) => engine._getPlayerStates(opponent).line
    )
  );
  const tiers = [[], [], []];
  for (const point of moves) {
    if (opponentLines.has(engine._getState(point))) {
      tiers[0].push(point);
    } else if (engine.getAdjacentPositions(point).some((adjacent) => engine._getState(adjacent) === ownLine)) {
      tiers[1].push(point);
    } else {
      tiers[2].push(point);
    }
  }
  return [...tiers[0], ...tiers[1], ...tiers[2]].slice(0, 20);
}
function materialKeys2(engine, player) {
  const nodes = new Set(engine._getPlayerNodes(player).map(pointKey3));
  const coverage = new Set(nodes);
  for (const line of engine._getPlayerLines(player)) coverage.add(pointKey3(line));
  return { nodes, coverage };
}
function lostKeys2(before, after) {
  return new Set([...before].filter((key3) => !after.has(key3)));
}
function weightedLoss2(nodes, coverage) {
  return MINIMAX_WEIGHTS2.lostNodes * nodes.size + MINIMAX_WEIGHTS2.lostCoverage * coverage.size;
}
function cutAnalysis2(engine, defender) {
  const before = materialKeys2(engine, defender);
  const lines = engine._getPlayerLines(defender);
  const threats = /* @__PURE__ */ new Map();
  for (const attacker of getOpponents2(engine, defender)) {
    const sourceNodes = engine._getPlayerNodes(attacker);
    for (const point of lines) {
      if (!engine._evaluateMove(point, attacker, sourceNodes).legal) continue;
      const snapshot = saveState2(engine);
      try {
        engine.currentPlayer = attacker;
        if (!engine._addNode(point, sourceNodes)) continue;
        const after = materialKeys2(engine, defender);
        const lostNodes = lostKeys2(before.nodes, after.nodes);
        const lostCoverage = lostKeys2(before.coverage, after.coverage);
        const loss = weightedLoss2(lostNodes, lostCoverage);
        const key3 = pointKey3(point);
        const previous = threats.get(key3);
        if (!previous || loss > previous.loss) {
          threats.set(key3, {
            attacker,
            point: [...point],
            loss,
            lostNodes,
            lostCoverage
          });
        }
      } finally {
        restoreState2(engine, snapshot);
      }
    }
  }
  const damaging = [...threats.values()].filter(({ loss }) => loss > 0);
  const primary = damaging.reduce((best, threat) => !best || threat.loss > best.loss ? threat : best, null);
  const immediate = primary?.loss ?? 0;
  return { threats, immediate };
}
function cutThreats2(engine, defender) {
  return new Map([...cutAnalysis2(engine, defender).threats].map(([key3, threat]) => [key3, threat.loss]));
}
function materialCounts2(engine, player) {
  const material = materialKeys2(engine, player);
  return { nodes: material.nodes.size, coverage: material.coverage.size };
}
function materialLoss2(engine, player, reference) {
  const remaining = materialCounts2(engine, player);
  return {
    nodes: Math.max(0, reference.nodes - remaining.nodes),
    coverage: Math.max(0, reference.coverage - remaining.coverage)
  };
}
function survivingPlayers2(engine) {
  return engine.activePlayers.filter((player) => !engine.resignedPlayers.has(player));
}
function comparePersistentLoss2(left, right) {
  return left.nodes - right.nodes || left.coverage - right.coverage;
}
function boundedRootCutChainRisk2(engine, defender) {
  const remainingPlayers = survivingPlayers2(engine);
  if (remainingPlayers.length !== 2 || !remainingPlayers.includes(defender)) return null;
  if (engine.gameOver || engine.currentPlayer === defender) {
    return { nodes: 0, coverage: 0, firstCuts: 0, responses: 0, transitions: 0 };
  }
  const reference = materialCounts2(engine, defender);
  const origin = saveState2(engine);
  const budget = { firstCuts: 0, responses: 0, transitions: 0 };
  const spendTransition = /* @__PURE__ */ __name(() => {
    budget.transitions += 1;
    if (budget.transitions > ROOT_CUT_CHAIN_LIMITS2.maxTransitions) {
      throw ROOT_CUT_CHAIN_LIMIT_REACHED2;
    }
  }, "spendTransition");
  let worstFirst = { nodes: 0, coverage: 0 };
  try {
    const firstPoints = engine._getPlayerLines(defender).map((point) => [...point]);
    for (const firstPoint of firstPoints) {
      const beforeFirst = saveState2(engine);
      try {
        spendTransition();
        if (!engine.playMove(firstPoint).success) continue;
        const firstLoss = materialLoss2(engine, defender, reference);
        if (firstLoss.nodes === 0 && firstLoss.coverage === 0) continue;
        budget.firstCuts += 1;
        if (budget.firstCuts > ROOT_CUT_CHAIN_LIMITS2.maxFirstCuts) {
          throw ROOT_CUT_CHAIN_LIMIT_REACHED2;
        }
        let responses;
        if (engine.gameOver || engine.currentPlayer !== defender) {
          responses = [null];
        } else {
          const sourceNodes = engine._getPlayerNodes(defender);
          const potentialResponses = engine.validPositions.reduce((count, point) => count + (sourceNodes.some((node) => engine.canConnectWithBlocking(point, node, defender)) ? 1 : 0), 0);
          if (potentialResponses > ROOT_CUT_CHAIN_LIMITS2.maxPotentialResponses) {
            throw ROOT_CUT_CHAIN_LIMIT_REACHED2;
          }
          const legal = engine.getLegalMoves(defender).map(({ point }) => [...point]);
          responses = [...legal, "PASS"];
          if (responses.length > ROOT_CUT_CHAIN_LIMITS2.maxResponsesPerCut) {
            throw ROOT_CUT_CHAIN_LIMIT_REACHED2;
          }
        }
        budget.responses += responses.length;
        let bestResponse = null;
        for (const response of responses) {
          const beforeResponse = saveState2(engine);
          try {
            if (response === "PASS") {
              spendTransition();
              if (!engine.skipTurn().success) continue;
            } else if (response !== null) {
              spendTransition();
              if (!engine.playMove(response).success) continue;
            }
            let worstSecond = materialLoss2(engine, defender, reference);
            if (!engine.gameOver && engine.currentPlayer !== defender) {
              const secondPoints = engine._getPlayerLines(defender).map((point) => [...point]);
              for (const secondPoint of secondPoints) {
                const beforeSecond = saveState2(engine);
                try {
                  spendTransition();
                  if (!engine.playMove(secondPoint).success) continue;
                  const secondLoss = materialLoss2(engine, defender, reference);
                  if (comparePersistentLoss2(secondLoss, worstSecond) > 0) {
                    worstSecond = secondLoss;
                  }
                } finally {
                  restoreState2(engine, beforeSecond);
                }
              }
            }
            if (bestResponse === null || comparePersistentLoss2(worstSecond, bestResponse) < 0) {
              bestResponse = worstSecond;
            }
          } finally {
            restoreState2(engine, beforeResponse);
          }
        }
        if (bestResponse !== null && comparePersistentLoss2(bestResponse, worstFirst) > 0) {
          worstFirst = bestResponse;
        }
      } finally {
        restoreState2(engine, beforeFirst);
      }
    }
    return { ...worstFirst, ...budget };
  } catch (error) {
    if (error === ROOT_CUT_CHAIN_LIMIT_REACHED2) return null;
    throw error;
  } finally {
    restoreState2(engine, origin);
  }
}
function boundedRootCutChainAttack2(engine, attacker, defenderReference) {
  const remainingPlayers = survivingPlayers2(engine);
  if (remainingPlayers.length !== 2 || !remainingPlayers.includes(attacker)) return null;
  const defender = remainingPlayers.find((player) => player !== attacker);
  if (!defender || !defenderReference) return null;
  const origin = saveState2(engine);
  const budget = { responses: 0, secondCuts: 0, transitions: 0 };
  const spendTransition = /* @__PURE__ */ __name(() => {
    budget.transitions += 1;
    if (budget.transitions > ROOT_CUT_CHAIN_LIMITS2.maxTransitions) {
      throw ROOT_CUT_CHAIN_LIMIT_REACHED2;
    }
  }, "spendTransition");
  try {
    if (engine.gameOver) {
      return { ...materialLoss2(engine, defender, defenderReference), ...budget };
    }
    let responses;
    if (engine.currentPlayer === attacker) {
      responses = [null];
    } else if (engine.currentPlayer === defender) {
      const sourceNodes = engine._getPlayerNodes(defender);
      const potentialResponses = engine.validPositions.reduce((count, point) => count + (sourceNodes.some((node) => engine.canConnectWithBlocking(point, node, defender)) ? 1 : 0), 0);
      if (potentialResponses > ROOT_CUT_CHAIN_LIMITS2.maxPotentialResponses) {
        throw ROOT_CUT_CHAIN_LIMIT_REACHED2;
      }
      const legal = engine.getLegalMoves(defender).map(({ point }) => [...point]);
      responses = [...legal, "PASS"];
      if (responses.length > ROOT_CUT_CHAIN_LIMITS2.maxResponsesPerCut) {
        throw ROOT_CUT_CHAIN_LIMIT_REACHED2;
      }
    } else {
      return null;
    }
    budget.responses += responses.length;
    let forcedLoss = null;
    for (const response of responses) {
      const beforeResponse = saveState2(engine);
      try {
        if (response === "PASS") {
          spendTransition();
          if (!engine.skipTurn().success) continue;
        } else if (response !== null) {
          spendTransition();
          if (!engine.playMove(response).success) continue;
        }
        let bestContinuation = materialLoss2(engine, defender, defenderReference);
        if (!engine.gameOver && engine.currentPlayer === attacker) {
          const secondPoints = engine._getPlayerLines(defender).map((point) => [...point]);
          for (const secondPoint of secondPoints) {
            const beforeSecond = saveState2(engine);
            try {
              spendTransition();
              if (!engine.playMove(secondPoint).success) continue;
              const secondLoss = materialLoss2(engine, defender, defenderReference);
              if (comparePersistentLoss2(secondLoss, bestContinuation) > 0) {
                bestContinuation = secondLoss;
              }
              budget.secondCuts += 1;
            } finally {
              restoreState2(engine, beforeSecond);
            }
          }
        }
        if (forcedLoss === null || comparePersistentLoss2(bestContinuation, forcedLoss) < 0) {
          forcedLoss = bestContinuation;
        }
      } finally {
        restoreState2(engine, beforeResponse);
      }
    }
    return forcedLoss === null ? null : { ...forcedLoss, ...budget };
  } catch (error) {
    if (error === ROOT_CUT_CHAIN_LIMIT_REACHED2) return null;
    throw error;
  } finally {
    restoreState2(engine, origin);
  }
}
function applyRootCutChainPreference2(engine, player, scoredMoves, eligibleKeys) {
  const remainingPlayers = survivingPlayers2(engine);
  if (remainingPlayers.length !== 2 || !remainingPlayers.includes(player)) return scoredMoves;
  if (!scoredMoves.length || scoredMoves[0].point === null) return scoredMoves;
  const window = scoredMoves.filter(({ point }) => point !== null && eligibleKeys.has(pointKey3(point))).slice(0, ROOT_CUT_CHAIN_LIMITS2.rankingWidth);
  if (!window.length || pointKey3(window[0].point) !== pointKey3(scoredMoves[0].point)) {
    return scoredMoves;
  }
  const opponent = remainingPlayers.find((candidate) => candidate !== player);
  const opponentReference = materialCounts2(engine, opponent);
  const comparisons = /* @__PURE__ */ new Map();
  for (const move of window) {
    const snapshot = saveState2(engine);
    try {
      if (!engine.playMove(move.point).success) return scoredMoves;
      if (engine.gameOver || engine.currentPlayer === player) continue;
      const risk = boundedRootCutChainRisk2(engine, player);
      if (risk === null) continue;
      const attack = boundedRootCutChainAttack2(engine, player, opponentReference);
      if (attack === null) continue;
      comparisons.set(pointKey3(move.point), {
        risk,
        attack,
        netNodeGain: attack.nodes - risk.nodes
      });
    } finally {
      restoreState2(engine, snapshot);
    }
  }
  const topKey = pointKey3(scoredMoves[0].point);
  const top = comparisons.get(topKey);
  if (!top) return scoredMoves;
  const dominant = window.filter((move) => {
    const comparison = comparisons.get(pointKey3(move.point));
    if (!comparison) return false;
    const riskComparison = comparePersistentLoss2(comparison.risk, top.risk);
    const attackComparison = comparePersistentLoss2(comparison.attack, top.attack);
    const defensiveDominance = comparison.netNodeGain >= top.netNodeGain && riskComparison < 0;
    const offensiveDominance = riskComparison <= 0 && attackComparison > 0;
    return defensiveDominance || offensiveDominance;
  });
  if (!dominant.length) return scoredMoves;
  dominant.sort((left, right) => {
    const leftComparison = comparisons.get(pointKey3(left.point));
    const rightComparison = comparisons.get(pointKey3(right.point));
    return rightComparison.netNodeGain - leftComparison.netNodeGain || comparePersistentLoss2(rightComparison.attack, leftComparison.attack) || comparePersistentLoss2(leftComparison.risk, rightComparison.risk) || window.indexOf(left) - window.indexOf(right);
  });
  const preferred = dominant[0];
  const preferredIndex = scoredMoves.indexOf(preferred);
  scoredMoves.splice(preferredIndex, 1);
  scoredMoves.unshift(preferred);
  return scoredMoves;
}
function opponentRiskMaterial2(engine, player) {
  return getOpponents2(engine, player).reduce((total, opponent) => {
    const nodes = engine._getPlayerNodes(opponent).length;
    const coverage = nodes + engine._getPlayerLines(opponent).length;
    return total + MINIMAX_WEIGHTS2.lostNodes * nodes + MINIMAX_WEIGHTS2.lostCoverage * coverage;
  }, 0);
}
function immediateRiskPenalty2(engine, player, previousOpponentMaterial) {
  if (engine.gameOver || engine.currentPlayer === player) return 0;
  const capturedMaterial = Math.max(
    0,
    previousOpponentMaterial - opponentRiskMaterial2(engine, player)
  );
  const pressure = cutAnalysis2(engine, player).immediate;
  return Math.max(0, pressure - capturedMaterial);
}
function evaluateMinimax2(engine, player) {
  const opponents = getOpponents2(engine, player);
  const myNodes = engine._getPlayerNodes(player);
  const myLines = engine._getPlayerLines(player);
  let opponentNodes = 0;
  let opponentCoverage = 0;
  let mainOpponent = null;
  let mainOpponentNodes = -1;
  let attacks = 0;
  for (const opponent of opponents) {
    const nodes = engine._getPlayerNodes(opponent);
    const lines = engine._getPlayerLines(opponent);
    opponentNodes += nodes.length;
    opponentCoverage += nodes.length + lines.length;
    if (nodes.length > mainOpponentNodes) {
      mainOpponent = opponent;
      mainOpponentNodes = nodes.length;
    }
    for (const point of lines) {
      if (engine._evaluateMove(point, player, myNodes).legal) attacks += 1;
    }
  }
  const reach = fastTerritoryBFS2(engine, player) - (mainOpponent === null ? 0 : fastTerritoryBFS2(engine, mainOpponent));
  const defensivePressure = cutAnalysis2(engine, player).immediate;
  return MINIMAX_WEIGHTS2.nodes * (myNodes.length - opponentNodes) + MINIMAX_WEIGHTS2.coverage * (myNodes.length + myLines.length - opponentCoverage) + MINIMAX_WEIGHTS2.reachableSpace * reach + MINIMAX_WEIGHTS2.attackOpportunity * attacks - defensivePressure;
}
function orderMinimaxMoves2(engine, moves, player) {
  const threats = cutThreats2(engine, player);
  const ownLine = engine._getPlayerStates(player).line;
  const enemyLines = new Set(getOpponents2(engine, player).map((opponent) => engine._getPlayerStates(opponent).line));
  return moves.map((point, index) => {
    const defense = threats.get(pointKey3(point)) ?? 0;
    const tier = defense >= MINIMAX_WEIGHTS2.lostNodes ? 0 : enemyLines.has(engine._getState(point)) ? 1 : engine.getAdjacentPositions(point).some((adjacent) => engine._getState(adjacent) === ownLine) ? 2 : 3;
    return { point, index, defense, tier };
  }).sort((left, right) => left.tier - right.tier || right.defense - left.defense || left.index - right.index).slice(0, 20).map(({ point }) => point);
}
var MINIMAX_WEIGHTS2, ROOT_CUT_CHAIN_LIMITS2, ROOT_CUT_CHAIN_LIMIT_REACHED2, MINIMAX_DEADLINE, MinimaxAI2, GreedyAI2, MCTSAI2;
var init_AIEngine = __esm({
  "application-hard:AIEngine.js"() {
    init_GameEngine();
    init_RootModeSearch();
    __name(pointKey3, "pointKey");
    __name(getOpponents2, "getOpponents");
    __name(cloneCachedTerritories2, "cloneCachedTerritories");
    __name(saveState2, "saveState");
    __name(restoreState2, "restoreState");
    __name(applyMoveForAI2, "applyMoveForAI");
    __name(applyMinimaxAction2, "applyMinimaxAction");
    __name(fastTerritoryBFS2, "fastTerritoryBFS");
    __name(evaluate2, "evaluate");
    __name(orderMoves2, "orderMoves");
    MINIMAX_WEIGHTS2 = Object.freeze({
      nodes: 30,
      coverage: 4,
      reachableSpace: 4,
      attackOpportunity: 4,
      // Potential loss is discounted relative to material already lost. A cut
      // must never become attractive merely because it clears a risk penalty.
      lostNodes: 24,
      lostCoverage: 3,
      // Extra preference for avoiding an uncompensated cut on the next turn.
      // This is a conservative root choice, in addition to the searched value.
      rootRiskAversion: 1.5
    });
    __name(materialKeys2, "materialKeys");
    __name(lostKeys2, "lostKeys");
    __name(weightedLoss2, "weightedLoss");
    __name(cutAnalysis2, "cutAnalysis");
    __name(cutThreats2, "cutThreats");
    ROOT_CUT_CHAIN_LIMITS2 = Object.freeze({
      rankingWidth: 4,
      maxFirstCuts: 4,
      maxPotentialResponses: 40,
      maxResponsesPerCut: 24,
      maxTransitions: 512
    });
    ROOT_CUT_CHAIN_LIMIT_REACHED2 = Symbol("ROOT_CUT_CHAIN_LIMIT_REACHED");
    __name(materialCounts2, "materialCounts");
    __name(materialLoss2, "materialLoss");
    __name(survivingPlayers2, "survivingPlayers");
    __name(comparePersistentLoss2, "comparePersistentLoss");
    __name(boundedRootCutChainRisk2, "boundedRootCutChainRisk");
    __name(boundedRootCutChainAttack2, "boundedRootCutChainAttack");
    __name(applyRootCutChainPreference2, "applyRootCutChainPreference");
    __name(opponentRiskMaterial2, "opponentRiskMaterial");
    __name(immediateRiskPenalty2, "immediateRiskPenalty");
    __name(evaluateMinimax2, "evaluateMinimax");
    __name(orderMinimaxMoves2, "orderMinimaxMoves");
    MINIMAX_DEADLINE = Symbol("minimax-deadline");
    MinimaxAI2 = class {
      static {
        __name(this, "MinimaxAI");
      }
      constructor(depth = 3, options = {}) {
        const {
          iterativeDeepening = false,
          extensionTimeMs = 100,
          maxExtraDepth = 2,
          now: now2 = /* @__PURE__ */ __name(() => performance.now(), "now")
        } = options;
        if (!Number.isFinite(extensionTimeMs) || extensionTimeMs <= 0 || !Number.isInteger(maxExtraDepth) || maxExtraDepth < 0 || maxExtraDepth > 2 || typeof now2 !== "function") throw new Error("Invalid Minimax deeper-search settings");
        this.depth = depth;
        this.searchOptions = options;
        Object.assign(this, { iterativeDeepening, extensionTimeMs, maxExtraDepth, now: now2 });
        this.lastSearch = null;
      }
      getLegalMoves(engine, player) {
        return engine.getLegalMoves(player).map((move) => move.point);
      }
      orderMoves(engine, moves, player) {
        return orderMinimaxMoves2(engine, moves, player);
      }
      evaluate(engine, player) {
        if (engine.gameOver) {
          const winner = engine.getWinner();
          if (winner === "DRAW") return 0;
          return winner === player ? 1e6 : -1e6;
        }
        return evaluateMinimax2(engine, player);
      }
      minimax(engine, depth, alpha, beta, aiPlayer) {
        this._checkDeadline?.();
        if (engine.gameOver || depth === 0) {
          const value = this.evaluate(engine, aiPlayer);
          this._checkDeadline?.();
          return value;
        }
        const legalMoves = this.getLegalMoves(engine, engine.currentPlayer);
        const ordered = this.orderMoves(engine, legalMoves, engine.currentPlayer);
        const actions = [...ordered, null];
        const maximizingPlayer = engine.currentPlayer === aiPlayer;
        if (maximizingPlayer) {
          let bestValue2 = Number.NEGATIVE_INFINITY;
          for (const point of actions) {
            this._checkDeadline?.();
            const snapshot = saveState2(engine);
            try {
              const applied = applyMinimaxAction2(engine, point, depth === 1);
              if (applied) {
                const value = this.minimax(engine, depth - 1, alpha, beta, aiPlayer);
                bestValue2 = Math.max(bestValue2, value);
                alpha = Math.max(alpha, bestValue2);
              }
            } finally {
              restoreState2(engine, snapshot);
            }
            if (beta <= alpha) {
              break;
            }
          }
          return bestValue2;
        }
        let bestValue = Number.POSITIVE_INFINITY;
        for (const point of actions) {
          this._checkDeadline?.();
          const snapshot = saveState2(engine);
          try {
            const applied = applyMinimaxAction2(engine, point, depth === 1);
            if (applied) {
              const value = this.minimax(engine, depth - 1, alpha, beta, aiPlayer);
              bestValue = Math.min(bestValue, value);
              beta = Math.min(beta, bestValue);
            }
          } finally {
            restoreState2(engine, snapshot);
          }
          if (beta <= alpha) {
            break;
          }
        }
        return bestValue;
      }
      getTopMoves(engine, aiPlayer, topN = 5, options = {}) {
        if (engine.rootRulesVersion === "root-v2" || engine.playerCount === 2 && engine.boardShape === "diamond") {
          const search = new MinimaxAI(this.depth, this.searchOptions);
          Object.defineProperty(search, "depth", {
            configurable: true,
            get: /* @__PURE__ */ __name(() => this.depth, "get"),
            set: /* @__PURE__ */ __name((value) => {
              this.depth = value;
            }, "set")
          });
          const moves2 = search.getTopMoves(engine, aiPlayer, topN, options);
          this.lastSearch = search.lastSearch;
          return moves2;
        }
        if (Number.isFinite(options.deadline)) {
          return this.searchAtDepth(engine, aiPlayer, topN, options);
        }
        const base = this.searchAtDepth(engine, aiPlayer, topN, options);
        if (!this.iterativeDeepening || this.depth < 4 || !base.length || engine.gameOver || engine._getRemainingPlayers().length !== 2 || engine.validPositions.length > 55 || this.maxExtraDepth === 0) return base;
        const baseDepth = this.depth, baseStats = this.lastSearch;
        const started = this.now(), deadline = started + this.extensionTimeMs;
        if (!Number.isFinite(started) || !Number.isFinite(deadline)) throw new Error("Invalid Minimax search clock");
        let moves = base, completedDepth = baseDepth, interrupted = false;
        const iterations = [];
        try {
          for (let extra = 1; extra <= this.maxExtraDepth; extra++) {
            this.depth = baseDepth + extra;
            if (this.now() >= deadline) {
              iterations.push({ depth: this.depth, exactRoots: 0, complete: false });
              interrupted = true;
              break;
            }
            const { onProgress: _onProgress, ...iterationOptions } = options;
            const deeper = this.searchAtDepth(engine, aiPlayer, topN, { ...iterationOptions, deadline, clock: this.now });
            const stats = this.lastSearch;
            if (stats.partial || this.now() >= deadline) {
              iterations.push({ ...stats, complete: false });
              interrupted = true;
              break;
            }
            iterations.push({ ...stats, complete: true });
            moves = deeper;
            completedDepth = this.depth;
          }
          return moves;
        } finally {
          this.depth = baseDepth;
          this.lastSearch = {
            ...baseStats,
            depth: completedDepth,
            baseDepth,
            iterativeDeepening: true,
            extensionTimeMs: this.extensionTimeMs,
            extensionElapsedMs: this.now() - started,
            extensionInterrupted: interrupted,
            completedDepth,
            deeperIterations: iterations
          };
        }
      }
      searchAtDepth(engine, aiPlayer, topN = 5, options = {}) {
        const previousReplayFlag = engine._isReplayingBatch;
        const previousCheck = this._checkDeadline;
        const deadline = Number.isFinite(options.deadline) ? options.deadline : Infinity;
        const clock2 = options.clock ?? (() => performance.now());
        this._checkDeadline = () => {
          if (clock2() >= deadline) throw MINIMAX_DEADLINE;
        };
        this.lastSearch = null;
        engine._isReplayingBatch = true;
        try {
          const legalMoves = this.getLegalMoves(engine, aiPlayer);
          const ordered = this.orderMoves(engine, legalMoves, aiPlayer);
          const rootCutChainEligible = new Set(ordered.map(pointKey3));
          const previousOpponentMaterial = this.depth > 1 ? opponentRiskMaterial2(engine, aiPlayer) : 0;
          const scoredMoves = [];
          let incomplete = false;
          for (const point of [...ordered, null]) {
            if (clock2() >= deadline) {
              incomplete = true;
              break;
            }
            const snapshot = saveState2(engine);
            try {
              const applied = applyMinimaxAction2(engine, point, this.depth <= 1);
              if (applied) {
                const immediateRisk = this.depth > 1 ? immediateRiskPenalty2(engine, aiPlayer, previousOpponentMaterial) : 0;
                const score = this.minimax(
                  engine,
                  this.depth - 1,
                  Number.NEGATIVE_INFINITY,
                  Number.POSITIVE_INFINITY,
                  aiPlayer
                );
                scoredMoves.push({
                  point,
                  ...point === null ? { type: "pass" } : {},
                  score: score - MINIMAX_WEIGHTS2.rootRiskAversion * immediateRisk
                });
                if (typeof options.onProgress === "function") {
                  const best = scoredMoves.filter((move) => move.point !== null).sort((a, b) => b.score - a.score)[0];
                  if (best) options.onProgress(best, { reason: "partial-policy-candidate", complete: false });
                }
              }
            } catch (error) {
              if (error !== MINIMAX_DEADLINE) throw error;
              incomplete = true;
            } finally {
              restoreState2(engine, snapshot);
            }
            if (incomplete) break;
          }
          scoredMoves.sort((a, b) => b.score - a.score);
          if (!incomplete && clock2() >= deadline) incomplete = true;
          if (!incomplete && this.depth > 1) {
            applyRootCutChainPreference2(engine, aiPlayer, scoredMoves, rootCutChainEligible);
            if (clock2() >= deadline) incomplete = true;
          }
          this.lastSearch = {
            algorithm: "minimax",
            depth: this.depth,
            requestedDepth: this.depth,
            completedDepth: incomplete ? 0 : this.depth,
            partial: incomplete,
            evaluatedRoots: scoredMoves.length,
            exactRoots: scoredMoves.length
          };
          const selectedPass = scoredMoves[0]?.point === null ? scoredMoves[0] : null;
          const placementMoves = scoredMoves.filter(({ point }) => point !== null);
          return (selectedPass ? [selectedPass, ...placementMoves] : placementMoves).slice(0, topN);
        } finally {
          this._checkDeadline = previousCheck;
          engine._isReplayingBatch = previousReplayFlag;
        }
      }
    };
    GreedyAI2 = class {
      static {
        __name(this, "GreedyAI");
      }
      getLegalMoves(engine, player) {
        return engine.getLegalMoves(player).map((move) => move.point);
      }
      orderMoves(engine, moves, player) {
        return orderMoves2(engine, moves, player);
      }
      getTopMoves(engine, aiPlayer, topN = 5, options = {}) {
        if (engine.rootRulesVersion === "root-v2") return new GreedyAI().getTopMoves(engine, aiPlayer, topN, options);
        const previousReplayFlag = engine._isReplayingBatch;
        engine._isReplayingBatch = true;
        try {
          const legalMoves = this.getLegalMoves(engine, aiPlayer);
          if (legalMoves.length === 0) {
            return [];
          }
          const ordered = this.orderMoves(engine, legalMoves, aiPlayer);
          const scoredMoves = [];
          for (const point of ordered) {
            if (Number.isFinite(options.deadline) && performance.now() >= options.deadline) break;
            const snapshot = saveState2(engine);
            try {
              const applied = applyMoveForAI2(engine, point, true);
              if (applied) scoredMoves.push({ point, score: evaluate2(engine, aiPlayer) });
            } finally {
              restoreState2(engine, snapshot);
            }
            if (scoredMoves.length && typeof options.onProgress === "function") {
              options.onProgress([...scoredMoves].sort((a, b) => b.score - a.score)[0]);
            }
          }
          scoredMoves.sort((a, b) => b.score - a.score);
          if (Number.isFinite(options.deadline)) this.lastSearch = {
            algorithm: "greedy",
            partial: scoredMoves.length < ordered.length,
            evaluatedRoots: scoredMoves.length
          };
          return scoredMoves.slice(0, topN);
        } finally {
          engine._isReplayingBatch = previousReplayFlag;
        }
      }
    };
    MCTSAI2 = class {
      static {
        __name(this, "MCTSAI");
      }
      constructor({ simulations = 64, rolloutDepth = 40, exploration = Math.SQRT2, seed = 521288629 } = {}) {
        this.simulations = simulations;
        this.rolloutDepth = rolloutDepth;
        this.exploration = exploration;
        this.seed = seed >>> 0;
      }
      getLegalMoves(engine, player) {
        return engine.getLegalMoves(player).map((move) => move.point);
      }
      nextRandom() {
        this.seed = Math.imul(this.seed, 1664525) + 1013904223 >>> 0;
        return this.seed / 4294967296;
      }
      selectChild(node, rootPlayer) {
        const logParent = Math.log(Math.max(1, node.visits));
        const actorSign = node.playerToAct === rootPlayer ? 1 : -1;
        let bestScore = Number.NEGATIVE_INFINITY;
        let bestChildren = [];
        for (const child of node.children.values()) {
          const exploitation = actorSign * (child.valueSum / Math.max(1, child.visits));
          const exploration = this.exploration * Math.sqrt(logParent / child.visits);
          const score = exploitation + exploration;
          if (score > bestScore + 1e-12) {
            bestScore = score;
            bestChildren = [child];
          } else if (Math.abs(score - bestScore) <= 1e-12) {
            bestChildren.push(child);
          }
        }
        return bestChildren[Math.floor(this.nextRandom() * bestChildren.length)];
      }
      applyRandomMove(engine, point) {
        return applyMoveForAI2(engine, point, false);
      }
      rollout(engine, rootPlayer) {
        for (let step = 0; step < this.rolloutDepth && !engine.gameOver; step += 1) {
          const legalMoves = this.getLegalMoves(engine, engine.currentPlayer);
          if (!legalMoves.length) {
            engine.skipTurn();
            continue;
          }
          const point = legalMoves[Math.floor(this.nextRandom() * legalMoves.length)];
          if (!this.applyRandomMove(engine, point)) {
            break;
          }
        }
        return Math.tanh(evaluate2(engine, rootPlayer) / 100);
      }
      getTopMoves(engine, aiPlayer, topN = 5, options = {}) {
        if (engine.rootRulesVersion === "root-v2") {
          const search = new MCTSAI({ simulations: this.simulations, rolloutDepth: this.rolloutDepth, exploration: this.exploration, seed: this.seed });
          const moves = search.getTopMoves(engine, aiPlayer, topN, options);
          this.seed = search.seed;
          return moves;
        }
        const previousReplayFlag = engine._isReplayingBatch;
        engine._isReplayingBatch = true;
        try {
          const rootActions = this.getLegalMoves(engine, aiPlayer);
          if (!rootActions.length) return [];
          const rootSnapshot = saveState2(engine);
          const root = {
            playerToAct: aiPlayer,
            parent: null,
            action: null,
            unexpandedActions: rootActions.map((point) => [...point]),
            children: /* @__PURE__ */ new Map(),
            visits: 0,
            valueSum: 0
          };
          let completedSimulations = 0;
          try {
            for (let simulation = 0; simulation < this.simulations; simulation += 1) {
              if (Number.isFinite(options.deadline) && performance.now() >= options.deadline) break;
              restoreState2(engine, rootSnapshot);
              let node = root;
              while (!engine.gameOver && !node.unexpandedActions.length && node.children.size) {
                node = this.selectChild(node, aiPlayer);
                if (!this.applyRandomMove(engine, node.action)) break;
              }
              if (!engine.gameOver && node.unexpandedActions.length) {
                const index = Math.floor(this.nextRandom() * node.unexpandedActions.length);
                const [action] = node.unexpandedActions.splice(index, 1);
                if (this.applyRandomMove(engine, action)) {
                  const child = {
                    playerToAct: engine.currentPlayer,
                    parent: node,
                    action,
                    unexpandedActions: this.getLegalMoves(engine, engine.currentPlayer),
                    children: /* @__PURE__ */ new Map(),
                    visits: 0,
                    valueSum: 0
                  };
                  node.children.set(pointKey3(action), child);
                  node = child;
                }
              }
              const value = this.rollout(engine, aiPlayer);
              for (let cursor = node; cursor; cursor = cursor.parent) {
                cursor.visits += 1;
                cursor.valueSum += value;
              }
              completedSimulations++;
              if (typeof options.onProgress === "function" && root.children.size) {
                const leading = [...root.children.values()].sort((a, b) => b.visits - a.visits || b.valueSum / b.visits - a.valueSum / a.visits)[0];
                options.onProgress({
                  point: leading.action,
                  visits: leading.visits,
                  score: leading.valueSum / leading.visits
                });
              }
            }
          } finally {
            restoreState2(engine, rootSnapshot);
          }
          if (Number.isFinite(options.deadline)) this.lastSearch = {
            algorithm: "mcts",
            partial: completedSimulations < this.simulations,
            completedSimulations
          };
          return rootActions.map((point) => {
            const child = root.children.get(pointKey3(point));
            const visits = child?.visits ?? 0;
            const meanValue = visits ? child.valueSum / visits : 0;
            return { point, score: meanValue, visits, meanValue };
          }).sort((a, b) => b.visits - a.visits || b.meanValue - a.meanValue).slice(0, topN);
        } finally {
          engine._isReplayingBatch = previousReplayFlag;
        }
      }
    };
  }
});

// application-hard:ThreePlayerAI.js
function counts(engine, player) {
  const states = engine._getPlayerStates(player);
  const nodes = engine._getPlayerNodes(player).length;
  const lines = engine._getPlayerLines(player).length;
  const frontier = /* @__PURE__ */ new Set();
  for (const point of engine.validPositions) {
    if (![states.node, states.line].includes(engine._getState(point))) continue;
    for (const neighbor of engine.getAdjacentPositions(point)) {
      if (engine._getState(neighbor) === 0) frontier.add(neighbor.join(","));
    }
  }
  return { nodes, coverage: nodes + lines, reach: fastTerritoryBFS2(engine, player), frontier: frontier.size };
}
function stateFeatures(engine) {
  return Object.fromEntries(engine.activePlayers.map((player) => [player, counts(engine, player)]));
}
function featuresForMove(engine, player, point, before, after, previousState) {
  const count = engine.validPositions.length;
  const opponents = engine.activePlayers.filter((other) => other !== player && !engine.resignedPlayers?.has(other));
  const own3 = after[player];
  const maximum = /* @__PURE__ */ __name((field) => Math.max(0, ...opponents.map((other) => after[other][field])), "maximum");
  const lost = /* @__PURE__ */ __name((field) => opponents.reduce((total, other) => total + before[other][field] - after[other][field], 0), "lost");
  const scale = engine.gridSize - 1;
  const home = engine.initialPositions[player];
  const dx = point[0] - home[0], dy = point[1] - home[1];
  const distance = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dx + dy)) / scale;
  const barycentric = [point[0], point[1], scale - point[0] - point[1]];
  return [
    own3.nodes / count,
    own3.coverage / count,
    own3.reach / count,
    (own3.nodes - maximum("nodes")) / count,
    (own3.coverage - maximum("coverage")) / count,
    (own3.reach - maximum("reach")) / count,
    lost("nodes") / count,
    lost("coverage") / count,
    (own3.nodes - before[player].nodes) / count,
    (own3.coverage - before[player].coverage) / count,
    Number(opponents.some((other) => previousState === engine._getPlayerStates(other).line)),
    Number(previousState === engine._getPlayerStates(player).line),
    distance,
    3 * Math.min(...barycentric) / scale,
    own3.frontier / count,
    (own3.frontier - maximum("frontier")) / count
  ];
}
function threePlayerCandidates(engine, player = engine.currentPlayer) {
  if (engine.currentPlayer !== player) throw new Error("AI \u53EA\u80FD\u5206\u6790\u5F53\u524D\u884C\u52A8\u65B9\u3002");
  if (engine.gameOver) return [];
  const snapshot = saveState2(engine);
  const replayFlag = engine._isReplayingBatch;
  engine._isReplayingBatch = true;
  try {
    const before = stateFeatures(engine);
    const candidates = [];
    const legal = engine.getLegalMoves(player);
    for (const { point } of legal) {
      restoreState2(engine, snapshot);
      const previousState = engine._getState(point);
      if (!engine.playMove(point).success) continue;
      const after = stateFeatures(engine);
      candidates.push({ point: [...point], features: featuresForMove(engine, player, point, before, after, previousState) });
    }
    return candidates;
  } finally {
    restoreState2(engine, snapshot);
    engine._isReplayingBatch = replayFlag;
  }
}
function createThreePlayerModel(payload) {
  if (payload?.schema?.name !== "lifeline-three-player-policy" || payload.schema.version !== 1 || payload.id !== THREE_PLAYER_MODEL_ID || payload.rules_version !== "territory-v2" || JSON.stringify(payload.features) !== JSON.stringify(THREE_PLAYER_FEATURES) || !Array.isArray(payload.weights) || payload.weights.length !== THREE_PLAYER_FEATURES.length || !payload.weights.every((value) => Number.isFinite(value) && Math.abs(value) < 1e4) || !Number.isFinite(payload.temperature) || payload.temperature <= 0 || !Number.isInteger(payload.training?.three_player_samples) || payload.training.three_player_samples < 1 || !Number.isInteger(payload.training?.two_player_samples) || payload.training.two_player_samples < 1) {
    throw new Error("\u4E09\u4EBA AI \u6A21\u578B\u683C\u5F0F\u6216\u8BAD\u7EC3\u6765\u6E90\u65E0\u6548\u3002");
  }
  const spec = structuredClone(payload);
  return {
    spec,
    score(features) {
      return features.reduce((sum, value, index) => sum + value * spec.weights[index], 0) / spec.temperature;
    }
  };
}
async function loadThreePlayerModel(id = THREE_PLAYER_MODEL_ID) {
  if (id !== THREE_PLAYER_MODEL_ID) throw new Error(`\u672A\u627E\u5230\u4E09\u4EBA AI \u6A21\u578B\uFF1A${id}`);
  if (!modelPromise) modelPromise = (async () => {
    const response = await fetch(MODEL_URL);
    if (!response.ok) throw new Error(`\u65E0\u6CD5\u52A0\u8F7D\u4E09\u4EBA AI \u6A21\u578B\uFF08HTTP ${response.status}\uFF09\u3002`);
    return createThreePlayerModel(await response.json());
  })().catch((error) => {
    modelPromise = null;
    throw error;
  });
  return modelPromise;
}
var THREE_PLAYER_MODEL_ID, THREE_PLAYER_FEATURES, MODEL_URL, modelPromise, ThreePlayerAI;
var init_ThreePlayerAI = __esm({
  "application-hard:ThreePlayerAI.js"() {
    init_AIEngine();
    THREE_PLAYER_MODEL_ID = "three-player-policy-v1";
    THREE_PLAYER_FEATURES = Object.freeze([
      "own_nodes",
      "own_coverage",
      "own_reach",
      "node_lead",
      "coverage_lead",
      "reach_lead",
      "captured_nodes",
      "captured_coverage",
      "own_node_gain",
      "own_coverage_gain",
      "attack",
      "own_line",
      "distance_from_home",
      "centrality",
      "own_frontier",
      "opponent_frontier_lead"
    ]);
    MODEL_URL = new URL("./assets/research-ai/three-player-policy-v1.json?v=20261020-three1", new URL("./ThreePlayerAI.js", self.location.href).href);
    modelPromise = null;
    __name(counts, "counts");
    __name(stateFeatures, "stateFeatures");
    __name(featuresForMove, "featuresForMove");
    __name(threePlayerCandidates, "threePlayerCandidates");
    __name(createThreePlayerModel, "createThreePlayerModel");
    __name(loadThreePlayerModel, "loadThreePlayerModel");
    ThreePlayerAI = class {
      static {
        __name(this, "ThreePlayerAI");
      }
      constructor(model) {
        this.model = model;
      }
      getTopMoves(engine, player, topN = 5) {
        if (engine.playerCount !== 3 || !["territory-v2", "territory-v3"].includes(engine.rulesVersion) || engine.gridSize < 5 || engine.gridSize > 15) {
          throw new Error("\u4E09\u4EBA AI \u9700\u8981 5\u201315 \u8FB9\u957F\u7684 territory-v2 \u4E09\u4EBA\u5BF9\u5C40\u3002");
        }
        const candidates = threePlayerCandidates(engine, player);
        if (!candidates.length) return [];
        const logits = candidates.map((candidate) => this.model.score(candidate.features));
        if (!logits.every(Number.isFinite)) throw new Error("\u4E09\u4EBA AI \u8BC4\u5206\u65E0\u6548\u3002");
        const maximum = Math.max(...logits);
        const exponentials = logits.map((score) => Math.exp(score - maximum));
        const total = exponentials.reduce((sum, value) => sum + value, 0);
        return candidates.map((candidate, index) => ({
          point: candidate.point,
          score: logits[index],
          prior: exponentials[index] / total,
          visits: 1
        })).sort((a, b) => b.score - a.score || a.point[1] - b.point[1] || a.point[0] - b.point[0]).slice(0, Math.max(0, Math.floor(topN)));
      }
    };
  }
});

// application-hard:ThreePlayerModels.js
function threePlayerModelAsset(id = DEFAULT_THREE_PLAYER_MODEL_ID) {
  if (!Object.hasOwn(THREE_PLAYER_MODEL_HASHES, id)) throw new Error(`\u672A\u627E\u5230\u4E09\u4EBA AI \u6A21\u578B\uFF1A${id}`);
  return `assets/research-ai/${id}.json`;
}
function createSupportedThreePlayerModel(payload) {
  if (payload?.id === "three-player-policy-v1") return createThreePlayerModel(payload);
  const training = payload?.training;
  if (payload?.id !== "three-player-policy-v2" || payload.schema?.name !== "lifeline-three-player-policy" || payload.schema.version !== 1 || payload.rules_version !== "territory-v2" || JSON.stringify(payload.features) !== JSON.stringify(THREE_PLAYER_FEATURES) || !Array.isArray(payload.weights) || payload.weights.length !== THREE_PLAYER_FEATURES.length || !payload.weights.every((value) => Number.isFinite(value) && Math.abs(value) < 1e4) || payload.temperature !== 1 || !Number.isInteger(training?.posttraining_samples) || training.posttraining_samples < 1 || !Number.isInteger(training?.validation_samples) || training.validation_samples < 1 || training.parent_model_id !== "three-player-policy-v1" || training.parent_model_sha256 !== THREE_PLAYER_MODEL_HASHES["three-player-policy-v1"] || !isHash(training.protocol_sha256) || !training.source_hashes || !Object.keys(training.source_hashes).length || !Object.values(training.source_hashes).every(isHash) || payload.lineage?.type !== "weights-only-warm-start" || payload.lineage.parent_id !== training.parent_model_id || payload.lineage.parent_sha256 !== training.parent_model_sha256) {
    throw new Error("\u4E09\u4EBA AI \u6A21\u578B\u683C\u5F0F\u6216\u540E\u8BAD\u7EC3\u6765\u6E90\u65E0\u6548\u3002");
  }
  const spec = structuredClone(payload);
  return {
    spec,
    score(features) {
      return features.reduce((sum, value, index) => sum + value * spec.weights[index], 0);
    }
  };
}
async function loadThreePlayerModel2(id = DEFAULT_THREE_PLAYER_MODEL_ID) {
  const asset = threePlayerModelAsset(id);
  if (id === "three-player-policy-v1") return loadThreePlayerModel(id);
  if (!promises.has(id)) {
    promises.set(id, (async () => {
      const response = await fetch(new URL(`./${asset}`, new URL("./ThreePlayerModels.js", self.location.href).href));
      if (!response.ok) throw new Error(`\u65E0\u6CD5\u52A0\u8F7D\u4E09\u4EBA AI \u6A21\u578B\uFF08HTTP ${response.status}\uFF09\u3002`);
      const bytes = await response.arrayBuffer();
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      if (hash !== THREE_PLAYER_MODEL_HASHES[id]) throw new Error("\u4E09\u4EBA AI \u6A21\u578B\u6821\u9A8C\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\u3002");
      const model = createSupportedThreePlayerModel(JSON.parse(new TextDecoder().decode(bytes)));
      if (model.spec.id !== id) throw new Error("\u4E09\u4EBA AI \u6A21\u578B\u8EAB\u4EFD\u4E0D\u5339\u914D\u3002");
      return model;
    })().catch((error) => {
      promises.delete(id);
      throw error;
    }));
  }
  return promises.get(id);
}
var DEFAULT_THREE_PLAYER_MODEL_ID, THREE_PLAYER_MODEL_HASHES, promises, isHash;
var init_ThreePlayerModels = __esm({
  "application-hard:ThreePlayerModels.js"() {
    init_ThreePlayerAI();
    DEFAULT_THREE_PLAYER_MODEL_ID = "three-player-policy-v1";
    THREE_PLAYER_MODEL_HASHES = Object.freeze({
      "three-player-policy-v1": "8cd1a2f36267f96b1e32b7749a9cdc785f489ea7ec12e31aee0beb0a72901794",
      "three-player-policy-v2": "00fc241c500dfd01ff85b5e2a4f1907cc5a9d8307d68bb78be64b0aad129f56e"
    });
    promises = /* @__PURE__ */ new Map();
    isHash = /* @__PURE__ */ __name((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "isHash");
    __name(threePlayerModelAsset, "threePlayerModelAsset");
    __name(createSupportedThreePlayerModel, "createSupportedThreePlayerModel");
    __name(loadThreePlayerModel2, "loadThreePlayerModel");
  }
});

// application-hard:ThreePlayerSearchAI.js
function validWeights(spec) {
  return Array.isArray(spec.weights) && spec.weights.length === THREE_PLAYER_FEATURES.length && spec.weights.every(Number.isFinite) && Number.isFinite(spec.temperature) && spec.temperature > 0;
}
function positionUtilityV4(engine, player, spec) {
  engine.cachedTerritories = { ...engine.cachedTerritories };
  GameEngine.prototype._updateTerritories.call(engine);
  const players = engine.activePlayers.filter((p) => !engine.resignedPlayers.has(p));
  const areas = Object.fromEntries(players.map((p) => [p, engine.cachedTerritories[p].area]));
  const bestArea = Math.max(...players.map((p) => areas[p]));
  const leaders = players.filter((p) => areas[p] === bestArea);
  const count = engine.validPositions.length;
  const margin = (areas[player] - Math.max(...players.filter((p) => p !== player).map((p) => areas[p]))) / count;
  if (engine.gameOver) return { value: leaders.includes(player) ? 1 / leaders.length : 0, margin, terminal: true, areas };
  const strengths = players.map((p) => areas[p] + spec.coverageWeight * (engine._getPlayerNodes(p).length + engine._getPlayerLines(p).length) + spec.reachWeight * fastTerritoryBFS2(engine, p));
  const maximum = Math.max(...strengths);
  const exp = strengths.map((value) => Math.exp((value - maximum) / (count * spec.valueTemperature)));
  return { value: exp[players.indexOf(player)] / exp.reduce((a, b) => a + b, 0), margin, terminal: false, areas };
}
var pointOrder, linear, ThreePlayerSearchAI;
var init_ThreePlayerSearchAI = __esm({
  "application-hard:ThreePlayerSearchAI.js"() {
    init_AIEngine();
    init_ThreePlayerAI();
    init_GameEngine();
    pointOrder = /* @__PURE__ */ __name((a, b) => a.point[1] - b.point[1] || a.point[0] - b.point[0], "pointOrder");
    linear = /* @__PURE__ */ __name((spec) => ({ score: /* @__PURE__ */ __name((values) => values.reduce((sum, value, i) => sum + value * spec.weights[i], 0) / spec.temperature, "score") }), "linear");
    __name(validWeights, "validWeights");
    __name(positionUtilityV4, "positionUtilityV4");
    ThreePlayerSearchAI = class {
      static {
        __name(this, "ThreePlayerSearchAI");
      }
      constructor(payload) {
        const s = payload.search;
        if (payload.schema?.name !== "lifeline-three-player-search" || payload.schema.version !== 4 || payload.rules_version !== "territory-v2" || !validWeights(payload) || JSON.stringify(payload.features) !== JSON.stringify(THREE_PLAYER_FEATURES) || !s || !Number.isInteger(s.rootWidth) || s.rootWidth < 1 || s.rootWidth > 8 || !Number.isInteger(s.rolloutPlies) || s.rolloutPlies < 1 || s.rolloutPlies > 48 || !Array.isArray(s.opponents) || !s.opponents.length || s.opponents.length > 2 || !s.opponents.every(validWeights) || ![s.coverageWeight, s.reachWeight, s.valueTemperature, s.minimumImprovement].every(Number.isFinite) || s.coverageWeight < 0 || s.reachWeight < 0 || s.valueTemperature <= 0 || s.minimumImprovement < 0 || s.minimumImprovement > 1) throw new Error("INVALID v4 search policy");
        this.spec = structuredClone(payload);
        this.base = new ThreePlayerAI(linear(payload));
        this.responses = s.opponents.map((opponent) => new ThreePlayerAI(linear(opponent)));
        this.lastSearch = null;
      }
      getTopMoves(engine, player = engine.currentPlayer, topN = 5, options = {}) {
        this.lastSearch = { simulations: 0, simulatedActions: 0, terminalLeaves: 0, elapsedMs: 0, evaluated: [] };
        if (engine.playerCount !== 3 || !["territory-v2", "territory-v3"].includes(engine.rulesVersion) || engine.currentPlayer !== player || engine.gridSize < 5 || engine.gridSize > 15) throw new Error("INVALID v4 game contract");
        if (engine.gameOver) return [];
        const snapshot = saveState2(engine), flag = engine._isReplayingBatch;
        engine._isReplayingBatch = true;
        const started = Date.now(), stats = { simulations: 0, simulatedActions: 0, terminalLeaves: 0 };
        const timeout = Symbol("three-player-deadline");
        const check2 = /* @__PURE__ */ __name(() => {
          if (Number.isFinite(options.deadline) && performance.now() >= options.deadline) throw timeout;
        }, "check");
        let ranked = [];
        try {
          ranked = this.base.getTopMoves(engine, player, this.spec.search.rootWidth);
          if (!ranked.length) return [];
          if (typeof options.onProgress === "function") options.onProgress(ranked[0]);
          check2();
          if (ranked.length === 1) {
            this.lastSearch = { ...stats, elapsedMs: Date.now() - started, evaluated: [], forcedMove: true };
            return ranked.slice(0, Math.max(0, Math.floor(topN)));
          }
          const evaluated = [];
          for (const move of ranked) {
            check2();
            const leaves = [];
            for (const opponent of this.responses) {
              check2();
              restoreState2(engine, snapshot);
              if (!engine.playMove(move.point).success) throw new Error("INVALID v4 root action");
              stats.simulatedActions++;
              for (let ply = 0; ply < this.spec.search.rolloutPlies && !engine.gameOver; ply++) {
                check2();
                const policy = engine.currentPlayer === player ? this.base : opponent;
                const reply = policy.getTopMoves(engine, engine.currentPlayer, 1)[0]?.point ?? null;
                const result = reply ? engine.playMove(reply) : engine.skipTurn();
                if (!result.success) throw new Error("INVALID v4 rollout action");
                stats.simulatedActions++;
              }
              const leaf = positionUtilityV4(engine, player, this.spec.search);
              check2();
              leaves.push(leaf);
              stats.simulations++;
              stats.terminalLeaves += Number(leaf.terminal);
            }
            evaluated.push({
              point: [...move.point],
              baseScore: move.score,
              score: leaves.reduce((sum, leaf) => sum + leaf.value, 0) / leaves.length,
              margin: leaves.reduce((sum, leaf) => sum + leaf.margin, 0) / leaves.length,
              leaves,
              visits: leaves.length
            });
          }
          evaluated.sort((a, b) => b.score - a.score || b.margin - a.margin || b.baseScore - a.baseScore || pointOrder(a, b));
          const baseMove = evaluated.find((move) => move.point.toString() === ranked[0].point.toString());
          if (evaluated[0].score - baseMove.score < this.spec.search.minimumImprovement) {
            evaluated.splice(evaluated.indexOf(baseMove), 1);
            evaluated.unshift(baseMove);
          }
          const values = evaluated.map((move) => Math.exp(4 * move.score));
          const total = values.reduce((a, b) => a + b, 0);
          this.lastSearch = { ...stats, elapsedMs: Date.now() - started, evaluated: structuredClone(evaluated) };
          return evaluated.map((move, i) => ({ ...move, prior: values[i] / total })).slice(0, Math.max(0, Math.floor(topN)));
        } catch (error) {
          if (error !== timeout) throw error;
          this.lastSearch = {
            ...stats,
            elapsedMs: Date.now() - started,
            partial: true,
            decisionSource: "base-policy-before-incomplete-rollout"
          };
          return ranked.slice(0, Math.max(0, Math.floor(topN)));
        } finally {
          restoreState2(engine, snapshot);
          engine._isReplayingBatch = flag;
        }
      }
    };
  }
});

// application-hard:ThreePlayerSearchOptions.js
function threePlayerModelIdForBoard(gridSize) {
  return THREE_PLAYER_SEARCH_SIZES.includes(Number(gridSize)) ? THREE_PLAYER_SEARCH_MODEL_ID : "three-player-policy-v1";
}
var THREE_PLAYER_SEARCH_MODEL_ID, THREE_PLAYER_SEARCH_MODEL_SHA256, THREE_PLAYER_SEARCH_SIZES;
var init_ThreePlayerSearchOptions = __esm({
  "application-hard:ThreePlayerSearchOptions.js"() {
    THREE_PLAYER_SEARCH_MODEL_ID = "three-player-search-v4-round12";
    THREE_PLAYER_SEARCH_MODEL_SHA256 = "9b85f5fff27001d68407c30d6f707b461b1b468d657c8292339e97d23868c230";
    THREE_PLAYER_SEARCH_SIZES = Object.freeze([5, 7, 9]);
    __name(threePlayerModelIdForBoard, "threePlayerModelIdForBoard");
  }
});

// application-hard:ThreePlayerRuntime.js
var ThreePlayerRuntime_exports = {};
__export(ThreePlayerRuntime_exports, {
  loadThreePlayerRuntime: () => loadThreePlayerRuntime,
  loadThreePlayerSearchModel: () => loadThreePlayerSearchModel
});
async function loadThreePlayerSearchModel(id = THREE_PLAYER_SEARCH_MODEL_ID) {
  if (id !== THREE_PLAYER_SEARCH_MODEL_ID) throw new Error(`\u672A\u627E\u5230\u4E09\u4EBA\u641C\u7D22 AI \u6A21\u578B\uFF1A${id}`);
  if (!searchModelPromise) {
    searchModelPromise = (async () => {
      const response = await fetch(new URL(`./assets/research-ai/${id}.json`, new URL("./ThreePlayerRuntime.js", self.location.href).href));
      if (!response.ok) throw new Error(`\u65E0\u6CD5\u52A0\u8F7D\u4E09\u4EBA\u641C\u7D22 AI \u6A21\u578B\uFF08HTTP ${response.status}\uFF09\u3002`);
      const bytes = await response.arrayBuffer();
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      if (hash !== THREE_PLAYER_SEARCH_MODEL_SHA256) throw new Error("\u4E09\u4EBA\u641C\u7D22 AI \u6A21\u578B\u6821\u9A8C\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\u3002");
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      if (payload.id !== id) throw new Error("\u4E09\u4EBA\u641C\u7D22 AI \u6A21\u578B\u8EAB\u4EFD\u4E0D\u5339\u914D\u3002");
      new ThreePlayerSearchAI(payload);
      return payload;
    })().catch((error) => {
      searchModelPromise = void 0;
      throw error;
    });
  }
  return structuredClone(await searchModelPromise);
}
async function loadThreePlayerRuntime(modelId = "three-player-policy-v1", engine) {
  if (modelId === THREE_PLAYER_SEARCH_MODEL_ID) {
    if (engine.playerCount !== 3 || !["territory-v2", "territory-v3"].includes(engine.rulesVersion) || !THREE_PLAYER_SEARCH_SIZES.includes(engine.gridSize)) {
      throw new Error("\u4E09\u4EBA\u641C\u7D22 AI \u4EC5\u652F\u6301 territory-v2 \u7684 5\u30017\u30019 \u8DEF\u4E09\u4EBA\u5BF9\u5C40\u3002");
    }
    const payload = await loadThreePlayerSearchModel(modelId);
    return { ai: new ThreePlayerSearchAI(payload), modelInfo: {
      id: payload.id,
      evidenceTier: "independently-verified-application-final-v4",
      evaluatedBoardSizes: [...THREE_PLAYER_SEARCH_SIZES],
      compatibility: "territory-v2 three-player; 5/7/9",
      inheritedModelId: "three-player-policy-v2",
      newGradientUpdates: 0,
      candidateSha256: THREE_PLAYER_SEARCH_MODEL_SHA256,
      search: { rootWidth: payload.search.rootWidth, rolloutPlies: payload.search.rolloutPlies }
    } };
  }
  const model = await loadThreePlayerModel2(modelId);
  return { ai: new ThreePlayerAI(model), modelInfo: {
    id: model.spec.id,
    evidenceTier: model.spec.training.evidence_tier,
    trainedBoardSizes: model.spec.training.trained_board_sizes,
    compatibility: "territory-v2 three-player"
  } };
}
var searchModelPromise;
var init_ThreePlayerRuntime = __esm({
  "application-hard:ThreePlayerRuntime.js"() {
    init_ThreePlayerModels();
    init_ThreePlayerSearchAI();
    init_ThreePlayerSearchOptions();
    __name(loadThreePlayerSearchModel, "loadThreePlayerSearchModel");
    __name(loadThreePlayerRuntime, "loadThreePlayerRuntime");
  }
});

// application-hard:HexPlayerAI.js
var HexPlayerAI_exports = {};
__export(HexPlayerAI_exports, {
  HEX_PLAYER_FEATURES: () => HEX_PLAYER_FEATURES,
  HEX_PLAYER_MODEL_ID: () => HEX_PLAYER_MODEL_ID,
  HexPlayerAI: () => HexPlayerAI,
  createHexPlayerModel: () => createHexPlayerModel,
  hexPlayerCandidates: () => hexPlayerCandidates,
  loadHexPlayerModel: () => loadHexPlayerModel
});
function stateFeatures2(engine) {
  const points = engine.validPositions;
  const states = Uint8Array.from(points, (point) => engine._getState(point));
  const result = {};
  for (const player of engine.activePlayers) {
    const { node, line } = engine._getPlayerStates(player);
    const visited = new Uint8Array(points.length);
    const frontier = /* @__PURE__ */ new Set();
    const queue = new Int32Array(points.length);
    let count = 0;
    let nodes = 0;
    for (let index = 0; index < points.length; index += 1) {
      if (states[index] !== node && states[index] !== line) continue;
      if (states[index] === node) nodes += 1;
      visited[index] = 1;
      queue[count++] = index;
      for (const adjacent of engine._adjIdxList[index]) {
        if (states[adjacent] === 0) frontier.add(adjacent);
      }
    }
    const coverage = count;
    for (let head = 0; head < count; head += 1) {
      for (const adjacent of engine._adjIdxList[queue[head]]) {
        if (visited[adjacent] || states[adjacent] !== 0 && states[adjacent] !== node && states[adjacent] !== line) continue;
        visited[adjacent] = 1;
        queue[count++] = adjacent;
      }
    }
    result[player] = { nodes, coverage, reach: count, frontier: frontier.size };
  }
  return result;
}
function moveFeatures(engine, player, point, before, after, previousState) {
  const count = engine.validPositions.length;
  const opponents = engine.activePlayers.filter((other) => other !== player && !engine.resignedPlayers.has(other));
  const own3 = after[player];
  const maximum = /* @__PURE__ */ __name((field) => Math.max(0, ...opponents.map((other) => after[other][field])), "maximum");
  const lost = /* @__PURE__ */ __name((field) => opponents.reduce((sum, other) => sum + before[other][field] - after[other][field], 0), "lost");
  const radius = engine.gridSize - 1;
  const home = engine.initialPositions[player];
  const axialDistance = /* @__PURE__ */ __name((dx, dy) => Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dx + dy)), "axialDistance");
  const isHex = engine.playerCount >= 4;
  const centrality = isHex ? 1 - axialDistance(point[0] - radius, point[1] - radius) / radius : 3 * Math.min(point[0], point[1], radius - point[0] - point[1]) / radius;
  return [
    own3.nodes / count,
    own3.coverage / count,
    own3.reach / count,
    (own3.nodes - maximum("nodes")) / count,
    (own3.coverage - maximum("coverage")) / count,
    (own3.reach - maximum("reach")) / count,
    lost("nodes") / count,
    lost("coverage") / count,
    (own3.nodes - before[player].nodes) / count,
    (own3.coverage - before[player].coverage) / count,
    Number(opponents.some((other) => previousState === engine._getPlayerStates(other).line)),
    Number(previousState === engine._getPlayerStates(player).line),
    axialDistance(point[0] - home[0], point[1] - home[1]) / (radius * (isHex ? 2 : 1)),
    centrality,
    own3.frontier / count,
    (own3.frontier - maximum("frontier")) / count
  ];
}
function hexPlayerCandidates(engine, player = engine.currentPlayer) {
  if (engine.currentPlayer !== player) throw new Error("AI \u53EA\u80FD\u5206\u6790\u5F53\u524D\u884C\u52A8\u65B9\u3002");
  if (engine.gameOver || engine.resignedPlayers.has(player)) return [];
  const snapshot = saveState2(engine);
  const replayFlag = engine._isReplayingBatch;
  const autoSkip = engine._checkAndAutoSkip;
  const ownsAutoSkip = Object.prototype.hasOwnProperty.call(engine, "_checkAndAutoSkip");
  engine._isReplayingBatch = true;
  engine._checkAndAutoSkip = () => {
  };
  try {
    const before = stateFeatures2(engine);
    const legal = engine.getLegalMoves(player);
    const candidates = [];
    for (const { point } of legal) {
      restoreState2(engine, snapshot);
      const previousState = engine._getState(point);
      if (!engine.playMove(point).success) continue;
      const after = stateFeatures2(engine);
      candidates.push({
        point: [...point],
        features: moveFeatures(engine, player, point, before, after, previousState)
      });
    }
    return candidates;
  } finally {
    restoreState2(engine, snapshot);
    engine._isReplayingBatch = replayFlag;
    if (ownsAutoSkip) engine._checkAndAutoSkip = autoSkip;
    else delete engine._checkAndAutoSkip;
  }
}
async function createHexPlayerModel(payload) {
  if (payload?.schema?.name !== "lifeline-hex-player-policy" || payload.schema.version !== 1 || payload.id !== HEX_PLAYER_MODEL_ID || payload.rules_version !== "territory-v2" || JSON.stringify(payload.features) !== JSON.stringify(HEX_PLAYER_FEATURES) || JSON.stringify(payload.browser_inference?.player_counts) !== "[4,5,6]" || JSON.stringify(payload.browser_inference?.board_size_range) !== "[5,15]" || !Array.isArray(payload.weights) || payload.weights.length !== HEX_PLAYER_FEATURES.length || !payload.weights.every((value) => Number.isFinite(value) && Math.abs(value) < 1e4) || !Number.isFinite(payload.temperature) || payload.temperature <= 0 || !Number.isInteger(payload.training?.two_player_samples) || payload.training.two_player_samples < 1 || [4, 5, 6].some((count) => !Number.isInteger(payload.training?.hex_samples_by_count?.[count]) || payload.training.hex_samples_by_count[count] < 1) || payload.integrity?.algorithm !== "SHA-256" || !/^[a-f0-9]{64}$/.test(payload.integrity?.payload_sha256 ?? "")) {
    throw new Error("\u516D\u8FB9\u5F62 AI \u6A21\u578B\u683C\u5F0F\u6216\u8BAD\u7EC3\u6765\u6E90\u65E0\u6548\u3002");
  }
  const body = { ...payload };
  delete body.integrity;
  if (!globalThis.crypto?.subtle) throw new Error("\u65E0\u6CD5\u6821\u9A8C\u516D\u8FB9\u5F62 AI \u6A21\u578B\u5B8C\u6574\u6027\u3002");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body)));
  const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  if (hash !== payload.integrity.payload_sha256) throw new Error("\u516D\u8FB9\u5F62 AI \u6A21\u578B\u5B8C\u6574\u6027\u6821\u9A8C\u5931\u8D25\u3002");
  const spec = structuredClone(payload);
  Object.freeze(spec.weights);
  return {
    spec,
    score(features) {
      if (!Array.isArray(features) || features.length !== HEX_PLAYER_FEATURES.length || !features.every(Number.isFinite)) throw new Error("\u516D\u8FB9\u5F62 AI \u7279\u5F81\u65E0\u6548\u3002");
      return features.reduce((sum, value, index) => sum + value * spec.weights[index], 0) / spec.temperature;
    }
  };
}
async function loadHexPlayerModel(id = HEX_PLAYER_MODEL_ID) {
  if (id !== HEX_PLAYER_MODEL_ID) throw new Error(`\u672A\u627E\u5230\u516D\u8FB9\u5F62 AI \u6A21\u578B\uFF1A${id}`);
  if (!modelPromise2) modelPromise2 = (async () => {
    const response = await fetch(MODEL_URL2);
    if (!response.ok) throw new Error(`\u65E0\u6CD5\u52A0\u8F7D\u516D\u8FB9\u5F62 AI \u6A21\u578B\uFF08HTTP ${response.status}\uFF09\u3002`);
    return createHexPlayerModel(await response.json());
  })().catch((error) => {
    modelPromise2 = null;
    throw error;
  });
  return modelPromise2;
}
var HEX_PLAYER_MODEL_ID, HEX_PLAYER_FEATURES, MODEL_URL2, modelPromise2, HexPlayerAI;
var init_HexPlayerAI = __esm({
  "application-hard:HexPlayerAI.js"() {
    init_AIEngine();
    HEX_PLAYER_MODEL_ID = "hex-player-policy-v1";
    HEX_PLAYER_FEATURES = Object.freeze([
      "own_nodes",
      "own_coverage",
      "own_reach",
      "node_lead",
      "coverage_lead",
      "reach_lead",
      "captured_nodes",
      "captured_coverage",
      "own_node_gain",
      "own_coverage_gain",
      "attack",
      "own_line",
      "distance_from_home",
      "centrality",
      "own_frontier",
      "opponent_frontier_lead"
    ]);
    MODEL_URL2 = new URL("./assets/research-ai/hex-player-policy-v1.json?v=20261021-hexai1", new URL("./HexPlayerAI.js", self.location.href).href);
    modelPromise2 = null;
    __name(stateFeatures2, "stateFeatures");
    __name(moveFeatures, "moveFeatures");
    __name(hexPlayerCandidates, "hexPlayerCandidates");
    __name(createHexPlayerModel, "createHexPlayerModel");
    __name(loadHexPlayerModel, "loadHexPlayerModel");
    HexPlayerAI = class {
      static {
        __name(this, "HexPlayerAI");
      }
      constructor(model) {
        this.model = model;
      }
      getTopMoves(engine, player, topN = 5) {
        if (![4, 5, 6].includes(engine.playerCount) || !["territory-v2", "territory-v3"].includes(engine.rulesVersion) || engine.gridSize < 5 || engine.gridSize > 15) {
          throw new Error("\u516D\u8FB9\u5F62 AI \u9700\u8981\u8FB9\u957F 5\u201315\u30014\u20136 \u4EBA\u7684 territory-v2 \u5BF9\u5C40\u3002");
        }
        const candidates = hexPlayerCandidates(engine, player);
        if (!candidates.length) return [];
        const logits = candidates.map((candidate) => this.model.score(candidate.features));
        if (!logits.every(Number.isFinite)) throw new Error("\u516D\u8FB9\u5F62 AI \u8BC4\u5206\u65E0\u6548\u3002");
        const maximum = Math.max(...logits);
        const exponentials = logits.map((score) => Math.exp(score - maximum));
        const total = exponentials.reduce((sum, value) => sum + value, 0);
        return candidates.map((candidate, index) => ({
          point: candidate.point,
          score: logits[index],
          prior: exponentials[index] / total,
          visits: 1
        })).sort((a, b) => b.score - a.score || a.point[1] - b.point[1] || a.point[0] - b.point[0]).slice(0, Math.max(0, Math.floor(topN)));
      }
    };
  }
});

// application-hard:MultiplayerHardValue.js
function evaluateNonterminalTeacher(metrics, actor, alive, boardPointCount, {
  nodeWeight = 15 / 43,
  coverageWeight = 8 / 43,
  reachWeight = 20 / 43,
  valueTemperature = 0.12
} = {}) {
  check(Number.isInteger(boardPointCount) && boardPointCount > 0 && Array.isArray(alive) && alive.length > 0 && new Set(alive).size === alive.length && metrics?.[actor] && alive.every((player) => metrics[player]), "Invalid heuristic evaluation state");
  check([nodeWeight, coverageWeight, reachWeight, valueTemperature].every(Number.isFinite) && nodeWeight >= 0 && coverageWeight >= 0 && reachWeight >= 0 && nodeWeight + coverageWeight + reachWeight > 0 && valueTemperature > 0, "Invalid explicit heuristic evaluation weights");
  const heuristicStrengths = Object.fromEntries(Object.entries(metrics).map(([player, row]) => {
    check(["nodes", "coverage", "reach"].every((name) => Number.isFinite(row[name]) && row[name] >= 0), "Invalid heuristic graph counts");
    return [player, nodeWeight * row.nodes + coverageWeight * row.coverage + reachWeight * row.reach];
  }));
  const values = alive.map((player) => heuristicStrengths[player]), maximum = Math.max(...values);
  const exp = values.map((value) => Math.exp((value - maximum) / (boardPointCount * valueTemperature)));
  const heuristicValue = alive.includes(actor) ? exp[alive.indexOf(actor)] / exp.reduce((sum, value) => sum + value, 0) : 0;
  const heuristicMargin = (heuristicStrengths[actor] - Math.max(0, ...alive.filter((player) => player !== actor).map((player) => heuristicStrengths[player]))) / boardPointCount;
  return { heuristicValue, heuristicMargin, heuristicStrengths };
}
function evaluateReplyResilience({
  boardPointCount,
  ownNodesAfterRoot,
  retainedOwnNodes,
  capturedNodesAfterRoot,
  retainedCapturedNodes,
  attackNodeSurvives,
  followupCutNodes = 0
}) {
  const counts2 = [
    boardPointCount,
    ownNodesAfterRoot,
    retainedOwnNodes,
    capturedNodesAfterRoot,
    retainedCapturedNodes,
    followupCutNodes
  ];
  check(counts2.every(Number.isInteger) && boardPointCount > 0 && counts2.slice(1).every((value) => value >= 0 && value <= boardPointCount) && retainedOwnNodes <= ownNodesAfterRoot && retainedCapturedNodes <= capturedNodesAfterRoot && typeof attackNodeSurvives === "boolean", "Invalid reply-resilience counts");
  const lostOwnNodes = ownNodesAfterRoot - retainedOwnNodes;
  const sustainedCutNodes = attackNodeSurvives ? retainedCapturedNodes : 0;
  return {
    score: (retainedOwnNodes - lostOwnNodes + sustainedCutNodes + followupCutNodes) / (3 * boardPointCount),
    cutRisk: lostOwnNodes / boardPointCount,
    retainedOwnNodes,
    lostOwnNodes,
    sustainedCutNodes,
    attackNodeSurvives,
    followupCutNodes
  };
}
function compareCompletedReplyResilience(candidate, incumbent, { anchor = incumbent } = {}) {
  for (const packet of [candidate, incumbent, anchor]) {
    check(
      packet?.complete === true && packet.reason === "complete" && packet.terminalRoot === false && typeof packet.replyPlayer === "string" && Number.isInteger(packet.repliesCompleted) && packet.repliesCompleted > 0 && ["maximumNodeLoss", "maximumCoverageLoss", "minimumRetainedCapturedNodes"].every((name) => Number.isInteger(packet[name]) && packet[name] >= 0) && Number.isInteger(packet.worstNetNodeGain) && packet.worstNetNodeGain === packet.minimumRetainedCapturedNodes - packet.maximumNodeLoss && Number.isFinite(packet.minimumDefenseSignal) && typeof packet.rootWasAttack === "boolean" && typeof packet.allRepliesRetainAttackNode === "boolean" && typeof packet.conditionalFollowupComplete === "boolean" && (packet.conditionalFollowupComplete ? Number.isInteger(packet.minimumFollowupCutNodes) && packet.minimumFollowupCutNodes >= 0 && typeof packet.allRepliesRetainFollowupCut === "boolean" && packet.allRepliesRetainFollowupCut === packet.minimumFollowupCutNodes >= 1 : packet.minimumFollowupCutNodes === null && packet.allRepliesRetainFollowupCut === null) && (!packet.allRepliesRetainAttackNode || packet.rootWasAttack),
      "Incomplete or invalid reply-resilience comparison"
    );
  }
  if (candidate.maximumNodeLoss < anchor.maximumNodeLoss && candidate.worstNetNodeGain < anchor.worstNetNodeGain)
    return 0;
  const chain = /* @__PURE__ */ __name((packet) => packet.allRepliesRetainFollowupCut ? packet.minimumFollowupCutNodes : 0, "chain");
  return incumbent.maximumNodeLoss - candidate.maximumNodeLoss || candidate.worstNetNodeGain - incumbent.worstNetNodeGain || incumbent.maximumCoverageLoss - candidate.maximumCoverageLoss || Number(candidate.allRepliesRetainAttackNode) - Number(incumbent.allRepliesRetainAttackNode) || (candidate.conditionalFollowupComplete && incumbent.conditionalFollowupComplete ? chain(candidate) - chain(incumbent) : 0);
}
var check;
var init_MultiplayerHardValue = __esm({
  "application-hard:MultiplayerHardValue.js"() {
    check = /* @__PURE__ */ __name((condition, message) => {
      if (!condition) throw new Error(message);
    }, "check");
    __name(evaluateNonterminalTeacher, "evaluateNonterminalTeacher");
    __name(evaluateReplyResilience, "evaluateReplyResilience");
    __name(compareCompletedReplyResilience, "compareCompletedReplyResilience");
  }
});

// application-hard:MultiplayerClock.js
var nativeClock, lastWallTime, multiplayerClock;
var init_MultiplayerClock = __esm({
  "application-hard:MultiplayerClock.js"() {
    nativeClock = globalThis.performance;
    lastWallTime = 0;
    multiplayerClock = {
      now: typeof nativeClock?.now === "function" ? () => nativeClock.now() : () => {
        lastWallTime = Math.max(lastWallTime, Date.now());
        return lastWallTime;
      }
    };
  }
});

// application-hard:MultiplayerNativeGeometry.js
function installNativeEdgeGeometry(engine, { maximumEntries = 2048 } = {}) {
  if (!Number.isInteger(maximumEntries) || maximumEntries < 1) throw new Error("Invalid edge geometry limit");
  const methods = [
    "_cleanupBrokenEdges",
    "_getOpponentConnectedPieces",
    "_getState",
    "getLinePoints",
    "canConnect",
    "isValidPosition"
  ];
  for (const name of methods) {
    if (engine[name] !== GameEngine.prototype[name]) throw new Error(`Native edge geometry requires native ${name}`);
  }
  const shape = engine.boardShape, size = engine.gridSize, positions = engine.validPositions;
  const edges = /* @__PURE__ */ new Map(), stats = { calls: 0, hits: 0, misses: 0, evictions: 0 };
  const guard = /* @__PURE__ */ __name((receiver) => {
    if (receiver !== engine || engine.boardShape !== shape || engine.gridSize !== size || engine.validPositions !== positions || engine._getState !== GameEngine.prototype._getState || engine.getLinePoints !== GameEngine.prototype.getLinePoints || engine.canConnect !== GameEngine.prototype.canConnect || engine.isValidPosition !== GameEngine.prototype.isValidPosition)
      throw new Error("Native edge geometry contract changed");
  }, "guard");
  const compile = /* @__PURE__ */ __name((edge) => {
    stats.calls++;
    const cached = edges.get(edge);
    if (cached) {
      stats.hits++;
      return cached;
    }
    stats.misses++;
    const [a, b] = edge.split("|");
    const parse = /* @__PURE__ */ __name((key3) => key3.split(",").map(Number), "parse");
    const keys = engine.getLinePoints(parse(a), parse(b)).map((p) => `${p[0]},${p[1]}`);
    const compiled = { a, b, keys };
    if (edges.size >= maximumEntries) {
      edges.delete(edges.keys().next().value);
      stats.evictions++;
    }
    edges.set(edge, compiled);
    return compiled;
  }, "compile");
  engine._cleanupBrokenEdges = function(player) {
    guard(this);
    const { node, line } = this._getPlayerStates(player), edgeSet = this._getEdges(player);
    for (const edge of [...edgeSet]) {
      if (!compile(edge).keys.every((key3) => {
        const state = this.grid.get(key3);
        return state === node || state === line;
      })) edgeSet.delete(edge);
    }
  };
  engine._getOpponentConnectedPieces = function(opponent) {
    guard(this);
    const { node } = this._getPlayerStates(opponent), initial = this._getInitialPosition(opponent);
    if (this._getState(initial) !== node) return /* @__PURE__ */ new Set();
    this._cleanupBrokenEdges(opponent);
    const edgeSet = this._getEdges(opponent), adjacency = /* @__PURE__ */ new Map();
    for (const edge of edgeSet) {
      const { a, b } = compile(edge);
      if (!adjacency.has(a)) adjacency.set(a, []);
      if (!adjacency.has(b)) adjacency.set(b, []);
      adjacency.get(a).push(b);
      adjacency.get(b).push(a);
    }
    const initialKey = `${initial[0]},${initial[1]}`, aliveNodes = /* @__PURE__ */ new Set([initialKey]), queue = [initialKey];
    for (let head = 0; head < queue.length; head++) {
      for (const next of adjacency.get(queue[head]) ?? []) {
        if (!aliveNodes.has(next)) {
          aliveNodes.add(next);
          queue.push(next);
        }
      }
    }
    const alive = new Set(aliveNodes);
    for (const edge of edgeSet) {
      const { a, b, keys } = compile(edge);
      if (aliveNodes.has(a) && aliveNodes.has(b)) for (const key3 of keys) alive.add(key3);
    }
    return alive;
  };
  return { stats, get size() {
    return edges.size;
  } };
}
var init_MultiplayerNativeGeometry = __esm({
  "application-hard:MultiplayerNativeGeometry.js"() {
    init_GameEngine();
    __name(installNativeEdgeGeometry, "installNativeEdgeGeometry");
  }
});

// application-hard:MultiplayerSearch.js
function boardGeometry(engine) {
  const id = `${engine.boardShape}/${engine.gridSize}`;
  if (!geometry.has(id)) geometry.set(id, {
    keys: engine.validPositions.map(key),
    rays: engine.validPositions.map((p) => engine._getCrawlRays(p).map((ray) => ray.map((c) => engine._keyToIdx.get(c.key))))
  });
  return geometry.get(id);
}
function potentialMoves(engine, player = engine.currentPlayer) {
  if (engine.gameOver || engine.resignedPlayers.has(player)) return [];
  const own3 = engine._getPlayerStates(player), indices = /* @__PURE__ */ new Set(), geo = boardGeometry(engine);
  const states = geo.keys.map((k) => engine.grid.get(k));
  const enemy = new Set(engine._getOpponents(player).flatMap((p) => Object.values(engine._getPlayerStates(p))));
  const nodes = new Set(engine.activePlayers.map((p) => engine._getPlayerStates(p).node));
  for (let i = 0; i < states.length; i++) {
    if (states[i] !== own3.node) continue;
    for (const ray of geo.rays[i]) for (const index of ray) {
      const state = states[index];
      if (!nodes.has(state)) indices.add(index);
      if (enemy.has(state)) break;
    }
  }
  return [...indices].sort((a, b) => a - b).filter((i) => {
    if (engine._isInProtectionZone(engine.validPositions[i], player)) return false;
    if (enemy.has(states[i])) return true;
    const adjacent = engine._adjIdxList[i].filter((j) => states[j] === own3.node);
    return adjacent.length < 2 && adjacent.every((j) => !engine._adjIdxList[j].some((k) => states[k] === own3.node));
  }).map((i) => engine.validPositions[i]);
}
function isolatedSearchEngine(source) {
  if (source.rootRulesVersion === "root-v2") throw new Error("Optimized multiplayer search does not support multi-root state.");
  const engine = new GameEngine({
    gridSize: source.gridSize,
    playerCount: source.playerCount,
    boardShape: source.boardShape,
    initialPositions: source.initialPositions,
    startPlayer: source.startPlayer,
    rulesVersion: source.rulesVersion,
    protectionRule: source.protectionRule,
    deferTerritoryUpdates: true
  });
  restoreState2(engine, saveState2(source));
  engine._isReplayingBatch = true;
  engine.getLegalMoves = function(player = this.currentPlayer) {
    const nodes = this._getPlayerNodes(player), hashOrder = this._getStateHashOrder();
    return potentialMoves(this, player).flatMap((point) => {
      const v = this._evaluateMove(point, player, nodes, hashOrder);
      return v.legal ? [{ point: [...point], state: v.state, isAttack: v.isAttack }] : [];
    });
  };
  const lastLegal = /* @__PURE__ */ new Map();
  engine._hasValidMoves = function(player) {
    if (this.gameOver || this.resignedPlayers.has(player)) return false;
    const nodes = this._getPlayerNodes(player), hashOrder = this._getStateHashOrder();
    const previous = lastLegal.get(player);
    if (previous && this._evaluateMove(previous, player, nodes, hashOrder).legal) return true;
    for (const point of potentialMoves(this, player)) if (this._evaluateMove(point, player, nodes, hashOrder).legal) {
      lastLegal.set(player, point);
      return true;
    }
    return false;
  };
  installNativeEdgeGeometry(engine);
  return engine;
}
function multiplayerMetrics(engine) {
  const n = engine.validPositions.length, owner = new Int8Array(n).fill(-1);
  const states = engine.validPositions.map((p) => engine._getState(p));
  const colors = engine.activePlayers, result = {};
  const stateOwner = /* @__PURE__ */ new Map();
  colors.forEach((p, i) => {
    const s = engine._getPlayerStates(p);
    stateOwner.set(s.node, i);
    stateOwner.set(s.line, i);
    result[p] = { nodes: 0, coverage: 0, reach: 0, frontier: 0 };
  });
  states.forEach((s, i) => {
    if (!stateOwner.has(s)) return;
    const j = stateOwner.get(s), m = result[colors[j]];
    owner[i] = j;
    m.coverage++;
    m.reach++;
    m.nodes += Number(s === engine._getPlayerStates(colors[j]).node);
  });
  const seen = new Uint8Array(n), queue = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (owner[start] >= 0 || seen[start]) continue;
    let tail = 1, mask = 0;
    queue[0] = start;
    seen[start] = 1;
    for (let head = 0; head < tail; head++) {
      let neighborsMask = 0;
      for (const next of engine._adjIdxList[queue[head]]) {
        if (owner[next] >= 0) neighborsMask |= 1 << owner[next];
        else if (!seen[next]) {
          seen[next] = 1;
          queue[tail++] = next;
        }
      }
      mask |= neighborsMask;
      colors.forEach((p, i) => {
        if (neighborsMask & 1 << i) result[p].frontier++;
      });
    }
    colors.forEach((p, i) => {
      if (mask & 1 << i) result[p].reach += tail;
    });
  }
  return result;
}
function multiplayerMoveFeatures(engine, player, point, before, after, previous) {
  const n = engine.validPositions.length, r = engine.gridSize - 1;
  const opponents = engine.activePlayers.filter((p) => p !== player && !engine.resignedPlayers.has(p));
  const own3 = after[player], max = /* @__PURE__ */ __name((f) => Math.max(0, ...opponents.map((p) => after[p][f])), "max");
  const lost = /* @__PURE__ */ __name((f) => opponents.reduce((v, p) => v + before[p][f] - after[p][f], 0), "lost");
  const home = engine.initialPositions[player], distance = /* @__PURE__ */ __name((x, y) => Math.max(Math.abs(x), Math.abs(y), Math.abs(x + y)), "distance");
  const hex = engine.boardShape === "hexagon", diamond = engine.boardShape === "diamond";
  return [
    own3.nodes / n,
    own3.coverage / n,
    own3.reach / n,
    (own3.nodes - max("nodes")) / n,
    (own3.coverage - max("coverage")) / n,
    (own3.reach - max("reach")) / n,
    lost("nodes") / n,
    lost("coverage") / n,
    (own3.nodes - before[player].nodes) / n,
    (own3.coverage - before[player].coverage) / n,
    Number(opponents.some((p) => previous === engine._getPlayerStates(p).line)),
    Number(previous === engine._getPlayerStates(player).line),
    distance(point[0] - home[0], point[1] - home[1]) / (r * (hex || diamond ? 2 : 1)),
    hex ? 1 - distance(point[0] - r, point[1] - r) / r : diamond ? 2 * Math.min(point[0], point[1], r - point[0], r - point[1]) / r : 3 * Math.min(point[0], point[1], r - point[0] - point[1]) / r,
    own3.frontier / n,
    (own3.frontier - max("frontier")) / n
  ];
}
function checkpoint(engine) {
  return {
    grid: engine.grid,
    edges: engine.edges,
    historySize: engine.historyHashes.size,
    currentPlayer: engine.currentPlayer,
    gameOver: engine.gameOver,
    turnCount: engine.turnCount,
    consecutiveSkips: engine.consecutiveSkips,
    positionRevision: engine.positionRevision,
    territoryRevision: engine._territoryStateRevision
  };
}
function enter(engine) {
  const s = checkpoint(engine);
  engine.grid = new Map(engine.grid);
  engine.edges = Object.fromEntries(engine.activePlayers.map((p) => [p, new Set(engine.edges[p])]));
  return s;
}
function leave(engine, s) {
  const hashes = [...engine.historyHashes];
  for (let i = s.historySize; i < hashes.length; i++) engine.historyHashes.delete(hashes[i]);
  Object.assign(engine, {
    grid: s.grid,
    edges: s.edges,
    currentPlayer: s.currentPlayer,
    gameOver: s.gameOver,
    turnCount: s.turnCount,
    consecutiveSkips: s.consecutiveSkips,
    positionRevision: s.positionRevision,
    _territoryStateRevision: s.territoryRevision
  });
}
function visitPolicyCandidates(engine, player, visit, {
  before = multiplayerMetrics(engine),
  beforeCandidate = null,
  featureReader = defaultFeatures,
  diagnostics = null
} = {}) {
  if (player !== engine.currentPlayer) throw new Error("Only the current player can be analysed");
  const sourceNodes = engine._getPlayerNodes(player), hashOrder = engine._getStateHashOrder();
  const originalHash = engine._computeStateHash;
  const descriptor = Object.getOwnPropertyDescriptor(engine, "_computeStateHash");
  const stats = diagnostics ?? {};
  Object.assign(stats, {
    potentialCandidates: 0,
    legalCandidates: 0,
    hashProbes: 0,
    superkoRejected: 0,
    sampledLegalPositions: 0,
    nodeEnumerations: 1,
    hashOrderEnumerations: 1
  });
  let pending2 = null, features, readingFeatures = false;
  engine._computeStateHash = function(nextPlayer, orderedPoints) {
    const identity2 = originalHash.call(this, nextPlayer, orderedPoints);
    if (pending2 && !readingFeatures) {
      pending2.hashCalls++;
      if (pending2.hashCalls !== 1 || this !== engine || orderedPoints !== hashOrder)
        throw new Error("Native move-probe hash contract changed");
      stats.hashProbes++;
      if (!this.historyHashes.has(identity2)) {
        readingFeatures = true;
        try {
          features = featureReader(this, player, pending2.point, before, pending2.previous);
          stats.sampledLegalPositions++;
        } finally {
          readingFeatures = false;
        }
      }
    }
    return identity2;
  };
  try {
    for (const point of potentialMoves(engine, player)) {
      beforeCandidate?.(point);
      stats.potentialCandidates++;
      pending2 = { point, previous: engine._getState(point), hashCalls: 0 };
      features = void 0;
      const result = engine._evaluateMove(point, player, sourceNodes, hashOrder);
      pending2 = null;
      if (result.legal) {
        if (!Array.isArray(features) || features.length !== 16 || !features.every(Number.isFinite))
          throw new Error("Native probe did not produce the complete finite 16-feature vector");
        stats.legalCandidates++;
        visit({ point: [...point], features });
      } else {
        if (features !== void 0) throw new Error("Native probe legality changed after feature sampling");
        if (result.reason === "SUPERKO_VIOLATION") stats.superkoRejected++;
      }
    }
  } finally {
    pending2 = null;
    if (descriptor) Object.defineProperty(engine, "_computeStateHash", descriptor);
    else delete engine._computeStateHash;
  }
  return stats;
}
function fastPolicyCandidates(source, player = source.currentPlayer, options = {}) {
  if (player !== source.currentPlayer) throw new Error("Only the current player can be analysed");
  const engine = isolatedSearchEngine(source), candidates = [];
  visitPolicyCandidates(engine, player, (candidate) => candidates.push(candidate), options);
  return candidates;
}
function probeMultiplayerReplyResilience(source, point, {
  maxReplies = 32,
  maxProbes = 256,
  timeMs = 25,
  now: now2 = /* @__PURE__ */ __name(() => multiplayerClock.now(), "now"),
  deadline = null,
  followupMode = "full"
} = {}) {
  if (![3, 4, 5, 6].includes(source.playerCount) || !["territory-v2", "territory-v3"].includes(source.rulesVersion) || !Number.isInteger(source.gridSize) || source.gridSize < 5 || source.gridSize > 15 || source.gameOver || source.resignedPlayers.has(source.currentPlayer) || !Number.isInteger(maxReplies) || maxReplies < 1 || !Number.isInteger(maxProbes) || maxProbes < 1 || !Number.isFinite(timeMs) || timeMs < 0 || typeof now2 !== "function" || deadline !== null && !Number.isFinite(deadline) || !["full", "minimum", "none"].includes(followupMode))
    throw new Error("Invalid bounded reply-resilience request");
  const started = now2();
  if (!Number.isFinite(started)) throw new Error("Invalid reply-resilience clock");
  const end = Math.min(started + timeMs, deadline ?? Infinity);
  const STOP = Symbol("bounded reply-resilience");
  const result = {
    complete: false,
    reason: null,
    player: source.currentPlayer,
    rootPoint: point === null ? null : [...point],
    replyPlayer: null,
    repliesCompleted: 0,
    probes: 0,
    actions: 0,
    followupActions: 0,
    signal: null,
    worstReply: null,
    minimumFollowupCutNodes: null,
    allRepliesRetainFollowupCut: null,
    maximumNodeLoss: null,
    maximumCoverageLoss: null,
    allRepliesRetainAttackNode: null,
    rootWasAttack: null,
    minimumDefenseSignal: null,
    defenseWorstReply: null,
    minimumRetainedCapturedNodes: null,
    worstNetNodeGain: null,
    compositeSignalComplete: false,
    followupMode,
    conditionalFollowupComplete: false,
    scope: "one-actual-next-opponent; conditional-actor-followup; topology-signal-only",
    terminalRoot: false
  };
  const checkBudget = /* @__PURE__ */ __name(() => {
    const time = now2();
    if (!Number.isFinite(time)) throw new Error("Invalid reply-resilience clock");
    if (time >= end) {
      result.reason = "deadline";
      throw STOP;
    }
  }, "checkBudget");
  const engine = isolatedSearchEngine(source), actor = source.currentPlayer;
  let knownZeroFollowup = false, omittedFollowups = false;
  const boundProbes = /* @__PURE__ */ __name((target) => {
    const nativeEvaluate = target._evaluateMove;
    const descriptor = Object.getOwnPropertyDescriptor(target, "_evaluateMove");
    target._evaluateMove = function(...args) {
      checkBudget();
      if (result.probes >= maxProbes) {
        result.reason = "probe-limit";
        throw STOP;
      }
      result.probes++;
      const value = nativeEvaluate.apply(this, args);
      checkBudget();
      return value;
    };
    return () => {
      if (descriptor) Object.defineProperty(target, "_evaluateMove", descriptor);
      else delete target._evaluateMove;
    };
  }, "boundProbes");
  const restoreEvaluate = boundProbes(engine);
  const nodeKeys = /* @__PURE__ */ __name((player) => new Set(engine.validPositions.filter((p) => engine._getState(p) === engine._getPlayerStates(player).node).map(key)), "nodeKeys");
  const apply = /* @__PURE__ */ __name((action, target = engine) => {
    checkBudget();
    result.actions++;
    const outcome = action === null ? target.skipTurn() : target.playMove(action);
    checkBudget();
    if (!outcome.success) throw new Error(`Illegal reply-resilience action: ${outcome.reason}`);
  }, "apply");
  const bestConditionalFollowup = /* @__PURE__ */ __name(() => {
    if (engine.gameOver || engine.resignedPlayers.has(actor)) return { nodes: 0, point: null };
    const next = engine, replySnapshot = saveState2(next);
    next.currentPlayer = actor;
    const start = saveState2(next), opponents = next._getOpponents(actor);
    const enemyNodes = next.validPositions.flatMap((p) => opponents.flatMap((player) => next._getState(p) === next._getPlayerStates(player).node ? [{ coordinate: key(p), player }] : []));
    const nodes = next._getPlayerNodes(actor), hashOrder = next._getStateHashOrder();
    let best = { nodes: 0, point: null };
    try {
      for (const candidate of potentialMoves(next, actor)) {
        checkBudget();
        if (!opponents.some((player) => next._getState(candidate) === next._getPlayerStates(player).line)) continue;
        if (!next._evaluateMove(candidate, actor, nodes, hashOrder).legal) continue;
        result.followupActions++;
        apply(candidate, next);
        const captured = enemyNodes.filter((row) => next.grid.get(row.coordinate) !== next._getPlayerStates(row.player).node).length;
        if (captured > best.nodes) best = { nodes: captured, point: [...candidate] };
        restoreState2(next, start);
      }
      checkBudget();
      return best;
    } finally {
      restoreState2(next, replySnapshot);
    }
  }, "bestConditionalFollowup");
  try {
    checkBudget();
    const enemyNodes = engine.activePlayers.filter((p) => p !== actor && !engine.resignedPlayers.has(p)).flatMap((p) => [...nodeKeys(p)].map((coordinate) => ({ player: p, coordinate })));
    const isAttack = point !== null && engine._getOpponents(actor).some((p) => engine._getState(point) === engine._getPlayerStates(p).line);
    apply(point);
    const ownNodes = nodeKeys(actor);
    const ownStates = engine._getPlayerStates(actor);
    const ownCoverage = new Set(engine.validPositions.filter((p) => [ownStates.node, ownStates.line].includes(engine._getState(p))).map(key));
    const captured = enemyNodes.filter((row) => engine.grid.get(row.coordinate) !== engine._getPlayerStates(row.player).node);
    const snapshot = saveState2(engine);
    const measure = /* @__PURE__ */ __name((withFollowup = true) => {
      checkBudget();
      const connected = engine._getOpponentConnectedPieces(actor);
      const retainedOwnNodes = [...ownNodes].filter((coordinate) => connected.has(coordinate) && engine.grid.get(coordinate) === engine._getPlayerStates(actor).node).length;
      const retainedOwnCoverage = [...ownCoverage].filter((coordinate) => connected.has(coordinate) && [ownStates.node, ownStates.line].includes(engine.grid.get(coordinate))).length;
      const retainedCapturedNodes = captured.filter((row) => engine.grid.get(row.coordinate) !== engine._getPlayerStates(row.player).node).length;
      const attackNodeSurvives = Boolean(isAttack && connected.has(key(point)) && engine.grid.get(key(point)) === engine._getPlayerStates(actor).node);
      const omitFollowup = withFollowup && (followupMode === "none" || followupMode === "minimum" && knownZeroFollowup);
      const followup = withFollowup && !omitFollowup ? bestConditionalFollowup() : { nodes: 0, point: null };
      omittedFollowups ||= omitFollowup;
      if (withFollowup && !omitFollowup && followup.nodes === 0) knownZeroFollowup = true;
      checkBudget();
      const defense = evaluateReplyResilience({
        boardPointCount: engine.validPositions.length,
        ownNodesAfterRoot: ownNodes.size,
        retainedOwnNodes,
        capturedNodesAfterRoot: captured.length,
        retainedCapturedNodes,
        attackNodeSurvives
      });
      return {
        ...evaluateReplyResilience({
          boardPointCount: engine.validPositions.length,
          ownNodesAfterRoot: ownNodes.size,
          retainedOwnNodes,
          capturedNodesAfterRoot: captured.length,
          retainedCapturedNodes,
          attackNodeSurvives,
          followupCutNodes: followup.nodes
        }),
        followupCutPoint: followup.point,
        retainedOwnCoverage,
        lostOwnCoverage: ownCoverage.size - retainedOwnCoverage,
        retainedCapturedNodes,
        defenseScore: defense.score
      };
    }, "measure");
    result.terminalRoot = engine.gameOver;
    if (engine.gameOver || engine.currentPlayer === actor) {
      result.signal = measure(false);
      result.complete = true;
      result.reason = engine.gameOver ? "terminal-root" : "no-immediate-opponent";
      return result;
    }
    result.replyPlayer = engine.currentPlayer;
    let worst = null, defenseWorst = null, minimumFollowupCutNodes = Infinity;
    let maximumNodeLoss = 0, maximumCoverageLoss = 0, allRepliesRetainAttackNode = isAttack;
    let minimumRetainedCapturedNodes = Infinity;
    const evaluateReply = /* @__PURE__ */ __name((action) => {
      let outcome;
      if (action === null) {
        outcome = engine.skipTurn();
      } else {
        checkBudget();
        if (result.probes >= maxProbes) {
          result.reason = "probe-limit";
          throw STOP;
        }
        result.probes++;
        outcome = engine.playMove(action);
      }
      checkBudget();
      if (!outcome.success) {
        restoreState2(engine, snapshot);
        if (action !== null && ["INVALID_MOVE", "SUPERKO_VIOLATION"].includes(outcome.reason)) return false;
        throw new Error(`Illegal reply-resilience action: ${outcome.reason}`);
      }
      if (result.repliesCompleted >= maxReplies) {
        result.reason = "reply-limit";
        throw STOP;
      }
      result.actions++;
      const signal = measure();
      result.repliesCompleted++;
      minimumFollowupCutNodes = Math.min(minimumFollowupCutNodes, signal.followupCutNodes);
      maximumNodeLoss = Math.max(maximumNodeLoss, signal.lostOwnNodes);
      maximumCoverageLoss = Math.max(maximumCoverageLoss, signal.lostOwnCoverage);
      minimumRetainedCapturedNodes = Math.min(minimumRetainedCapturedNodes, signal.retainedCapturedNodes);
      allRepliesRetainAttackNode &&= signal.attackNodeSurvives;
      if (worst === null || signal.score < worst.signal.score)
        worst = { action: action === null ? null : [...action], signal };
      if (defenseWorst === null || signal.defenseScore < defenseWorst.signal.defenseScore)
        defenseWorst = { action: action === null ? null : [...action], signal };
      restoreState2(engine, snapshot);
      return true;
    }, "evaluateReply");
    for (const reply of potentialMoves(engine, result.replyPlayer)) {
      checkBudget();
      evaluateReply(reply);
    }
    evaluateReply(null);
    checkBudget();
    result.complete = true;
    result.reason = "complete";
    result.compositeSignalComplete = !omittedFollowups;
    result.signal = omittedFollowups ? null : worst.signal;
    result.worstReply = omittedFollowups ? null : worst.action;
    result.conditionalFollowupComplete = followupMode !== "none";
    result.minimumFollowupCutNodes = followupMode === "none" ? null : minimumFollowupCutNodes;
    result.allRepliesRetainFollowupCut = followupMode === "none" ? null : minimumFollowupCutNodes >= 1;
    result.maximumNodeLoss = maximumNodeLoss;
    result.maximumCoverageLoss = maximumCoverageLoss;
    result.allRepliesRetainAttackNode = allRepliesRetainAttackNode;
    result.rootWasAttack = isAttack;
    result.minimumDefenseSignal = defenseWorst.signal.defenseScore;
    result.defenseWorstReply = defenseWorst.action;
    result.minimumRetainedCapturedNodes = minimumRetainedCapturedNodes;
    result.worstNetNodeGain = minimumRetainedCapturedNodes - maximumNodeLoss;
  } catch (error) {
    if (error !== STOP) throw error;
  } finally {
    restoreEvaluate();
    result.elapsedMs = now2() - started;
  }
  return result;
}
function relativeUtility(engine, player, metrics = multiplayerMetrics(engine)) {
  const others = engine.activePlayers.filter((p) => p !== player && !engine.resignedPlayers.has(p));
  const strength = /* @__PURE__ */ __name((p) => 15 * metrics[p].nodes + 8 * metrics[p].coverage + 20 * metrics[p].reach, "strength");
  return (strength(player) - Math.max(0, ...others.map(strength))) / engine.validPositions.length;
}
var order, key, TIMEOUT, geometry, defaultFeatures, MultiplayerMinimaxAI;
var init_MultiplayerSearch = __esm({
  "application-hard:MultiplayerSearch.js"() {
    init_MultiplayerClock();
    init_MultiplayerNativeGeometry();
    init_GameEngine();
    init_AIEngine();
    init_MultiplayerHardValue();
    order = /* @__PURE__ */ __name((a, b) => a.point === null ? b.point === null ? 0 : 1 : b.point === null ? -1 : a.point[1] - b.point[1] || a.point[0] - b.point[0], "order");
    key = /* @__PURE__ */ __name((p) => p === null ? "PASS" : p.join(","), "key");
    TIMEOUT = Symbol("search deadline");
    geometry = /* @__PURE__ */ new Map();
    __name(boardGeometry, "boardGeometry");
    __name(potentialMoves, "potentialMoves");
    __name(isolatedSearchEngine, "isolatedSearchEngine");
    __name(multiplayerMetrics, "multiplayerMetrics");
    __name(multiplayerMoveFeatures, "multiplayerMoveFeatures");
    __name(checkpoint, "checkpoint");
    __name(enter, "enter");
    __name(leave, "leave");
    defaultFeatures = /* @__PURE__ */ __name((engine, player, point, before, previous) => multiplayerMoveFeatures(engine, player, point, before, multiplayerMetrics(engine), previous), "defaultFeatures");
    __name(visitPolicyCandidates, "visitPolicyCandidates");
    __name(fastPolicyCandidates, "fastPolicyCandidates");
    __name(probeMultiplayerReplyResilience, "probeMultiplayerReplyResilience");
    __name(relativeUtility, "relativeUtility");
    MultiplayerMinimaxAI = class {
      static {
        __name(this, "MultiplayerMinimaxAI");
      }
      constructor({ depth = 3, timeMs = 700, weights = null, rootPrior = null, pruning = true, nodeBudget = Infinity, exactScores = false, priorWeight = 0, allowPass = true } = {}) {
        this.depth = depth;
        this.timeMs = timeMs;
        this.weights = weights;
        this.rootPrior = rootPrior;
        this.pruning = pruning;
        this.nodeBudget = nodeBudget;
        this.exactScores = exactScores;
        this.priorWeight = priorWeight;
        this.allowPass = allowPass;
      }
      getTopMoves(source, player = source.currentPlayer, topN = 5, options = {}) {
        if (!["territory-v2", "territory-v3"].includes(source.rulesVersion) || source.currentPlayer !== player) throw new Error("Invalid multiplayer search state");
        const started = multiplayerClock.now(), deadline = Math.min(
          started + this.timeMs,
          Number.isFinite(options.deadline) ? options.deadline : Infinity
        );
        const engine = isolatedSearchEngine(source);
        const stats = this.lastSearch = {
          nodes: 0,
          cutoffs: 0,
          completedDepth: 0,
          elapsedMs: 0,
          timedOut: false,
          candidateCap: null,
          algorithm: "paranoid-alpha-beta",
          partialIterationDiscarded: false,
          terminalScoringInterrupted: false
        };
        const check2 = /* @__PURE__ */ __name(() => {
          if (multiplayerClock.now() >= deadline || stats.nodes >= this.nodeBudget) throw TIMEOUT;
        }, "check");
        const terminalCache = /* @__PURE__ */ new Map();
        const actions = /* @__PURE__ */ __name(() => [...potentialMoves(engine), ...this.allowPass && !engine.gameOver ? [null] : []], "actions");
        const apply = /* @__PURE__ */ __name((point) => point === null ? engine.skipTurn() : engine.playMove(point), "apply");
        const evaluate3 = /* @__PURE__ */ __name(() => {
          if (!engine.gameOver) return relativeUtility(engine, player);
          const position = engine._computeStateHash(engine.currentPlayer);
          if (terminalCache.has(position)) return terminalCache.get(position);
          const index = engine._keyToIdx, originalGet = index.get;
          let probes = 0;
          index.get = function(k) {
            if ((++probes & 63) === 0) check2();
            return originalGet.call(this, k);
          };
          try {
            check2();
            GameEngine.prototype._updateTerritories.call(engine);
            check2();
          } catch (error) {
            if (error === TIMEOUT) stats.terminalScoringInterrupted = true;
            throw error;
          } finally {
            delete index.get;
          }
          const remaining = engine.activePlayers.filter((p) => !engine.resignedPlayers.has(p));
          const max = Math.max(...remaining.map((p) => engine.cachedTerritories[p].area));
          const winners = remaining.filter((p) => engine.cachedTerritories[p].area === max);
          const value = winners.includes(player) ? 1e5 / winners.length : -1e5;
          terminalCache.set(position, value);
          return value;
        }, "evaluate");
        const rank = /* @__PURE__ */ __name((points, actor, preferred) => points.map((point) => {
          const state = point === null ? 0 : engine._getState(point), own3 = engine._getPlayerStates(actor);
          let score = state && state !== own3.line ? 1e3 : state === own3.line ? 1 : 0;
          if (preferred?.point && key(point) === key(preferred.point)) score += 1e4;
          return { point, score };
        }).sort((a, b) => b.score - a.score || order(a, b)), "rank");
        const visit = /* @__PURE__ */ __name((depth, alpha, beta) => {
          check2();
          stats.nodes++;
          if (depth === 0 || engine.gameOver) return evaluate3();
          const actor = engine.currentPlayer, maximizing = actor === player;
          let best = maximizing ? -Infinity : Infinity, found = false;
          for (const move of rank(actions(), actor)) {
            check2();
            const s = enter(engine);
            try {
              if (!apply(move.point).success) continue;
              found = true;
              const value = visit(depth - 1, alpha, beta);
              best = maximizing ? Math.max(best, value) : Math.min(best, value);
              if (maximizing) alpha = Math.max(alpha, best);
              else beta = Math.min(beta, best);
            } finally {
              leave(engine, s);
            }
            if (this.pruning && beta <= alpha) {
              stats.cutoffs++;
              break;
            }
          }
          if (!found) {
            const s = enter(engine);
            try {
              engine.skipTurn();
              return visit(depth - 1, alpha, beta);
            } finally {
              leave(engine, s);
            }
          }
          return best;
        }, "visit");
        let completed = [], roots = rank(actions(), player);
        try {
          const before = multiplayerMetrics(engine);
          for (const move of roots) {
            if (completed.length) check2();
            const previous = move.point === null ? 0 : engine._getState(move.point), s = enter(engine);
            try {
              if (!apply(move.point).success) continue;
              const metrics = multiplayerMetrics(engine);
              const features = move.point === null ? Array(16).fill(0) : multiplayerMoveFeatures(engine, player, move.point, before, metrics, previous);
              const policy = this.weights ? features.reduce((v, x, i) => v + x * this.weights[i], 0) : 0;
              const prior = this.rootPrior?.get(key(move.point)) ?? 0;
              const score = relativeUtility(engine, player, metrics) + this.priorWeight * prior;
              completed.push({
                point: move.point === null ? null : [...move.point],
                score,
                policy,
                prior,
                features,
                terminal: engine.gameOver,
                scoreBound: "heuristic"
              });
            } finally {
              leave(engine, s);
            }
          }
          completed.sort((a, b) => b.score - a.score || b.policy - a.policy || b.prior - a.prior || order(a, b));
          const firstIteration = [];
          for (const move of completed) {
            let score = move.score;
            if (move.terminal) {
              check2();
              const s = enter(engine);
              try {
                if (!apply(move.point).success) throw new Error("Legal root changed during isolated search");
                score = evaluate3() + this.priorWeight * move.prior;
              } finally {
                leave(engine, s);
              }
            }
            firstIteration.push({ ...move, score, scoreBound: "exact" });
          }
          firstIteration.sort((a, b) => b.score - a.score || b.policy - a.policy || b.prior - a.prior || order(a, b));
          completed = firstIteration;
          stats.completedDepth = 1;
          for (let depth = 2; depth <= this.depth && completed.length; depth++) {
            const iteration = [];
            let alpha = -Infinity;
            for (const move of completed) {
              check2();
              const s = enter(engine);
              try {
                if (!apply(move.point).success) throw new Error("Legal root changed during isolated search");
                const bias = this.priorWeight * move.prior;
                const window = this.exactScores || !this.pruning ? -Infinity : alpha - bias;
                const score = visit(depth - 1, window, Infinity) + bias;
                iteration.push({ ...move, score, scoreBound: score <= alpha && window !== -Infinity ? "upper" : "exact" });
                alpha = Math.max(alpha, score);
              } finally {
                leave(engine, s);
              }
            }
            iteration.sort((a, b) => b.score - a.score || Number(a.scoreBound === "upper") - Number(b.scoreBound === "upper") || b.policy - a.policy || b.prior - a.prior || order(a, b));
            completed = iteration;
            stats.completedDepth = depth;
          }
        } catch (error) {
          if (error !== TIMEOUT) throw error;
          stats.timedOut = true;
          stats.partialIterationDiscarded = stats.completedDepth > 0;
          if (stats.completedDepth === 0) completed.sort((a, b) => b.score - a.score || b.policy - a.policy || b.prior - a.prior || order(a, b));
        } finally {
          stats.elapsedMs = multiplayerClock.now() - started;
        }
        return completed.slice(0, topN).map(({ point, score, policy, prior, scoreBound = "exact" }) => ({ type: point === null ? "pass" : "move", point, score, policy, prior, scoreBound, visits: 1 }));
      }
    };
  }
});

// application-hard:MultiplayerHardRollout.js
function scorer(policy) {
  if (typeof policy?.score === "function") return (values) => policy.score(values);
  if (!Array.isArray(policy?.weights) || policy.weights.length !== 16 || !policy.weights.every(Number.isFinite) || !Number.isFinite(policy.temperature ?? 1) || (policy.temperature ?? 1) <= 0) throw new Error("Invalid rollout linear policy");
  return (values) => values.reduce((sum, value, i) => sum + value * policy.weights[i], 0) / (policy.temperature ?? 1);
}
function branch(engine) {
  const saved = {
    grid: engine.grid,
    edges: engine.edges,
    historySize: engine.historyHashes.size,
    currentPlayer: engine.currentPlayer,
    gameOver: engine.gameOver,
    turnCount: engine.turnCount,
    consecutiveSkips: engine.consecutiveSkips,
    positionRevision: engine.positionRevision,
    territoryStateRevision: engine._territoryStateRevision
  };
  engine.grid = new Map(engine.grid);
  engine.edges = Object.fromEntries(engine.activePlayers.map((p) => [p, new Set(engine.edges[p])]));
  return saved;
}
function rollback(engine, saved) {
  const appended = [...engine.historyHashes].slice(saved.historySize);
  for (const hash of appended) engine.historyHashes.delete(hash);
  Object.assign(engine, {
    grid: saved.grid,
    edges: saved.edges,
    currentPlayer: saved.currentPlayer,
    gameOver: saved.gameOver,
    turnCount: saved.turnCount,
    consecutiveSkips: saved.consecutiveSkips,
    positionRevision: saved.positionRevision,
    _territoryStateRevision: saved.territoryStateRevision
  });
}
var DEADLINE, key2, order2, MultiplayerRolloutAI;
var init_MultiplayerHardRollout = __esm({
  "application-hard:MultiplayerHardRollout.js"() {
    init_MultiplayerHardValue();
    init_GameEngine();
    init_AIEngine();
    init_MultiplayerSearch();
    DEADLINE = Symbol("multiplayer rollout budget");
    key2 = /* @__PURE__ */ __name((point) => point === null ? "PASS" : point.join(","), "key");
    order2 = /* @__PURE__ */ __name((a, b) => a.point === null ? b.point === null ? 0 : 1 : b.point === null ? -1 : a.point[1] - b.point[1] || a.point[0] - b.point[0], "order");
    __name(scorer, "scorer");
    __name(branch, "branch");
    __name(rollback, "rollback");
    MultiplayerRolloutAI = class {
      static {
        __name(this, "MultiplayerRolloutAI");
      }
      constructor({
        basePolicy,
        responsePolicies = [basePolicy],
        fallbackPolicy = null,
        fallbackMove = null,
        rootPriors = null,
        timeMs = 650,
        rolloutPlies = 12,
        minimumImprovement = 0.02,
        coverageWeight = 0.3,
        reachWeight = 0.05,
        valueTemperature = 0.12,
        nodeBudget = Infinity,
        allowPass = true,
        reuseRootRanking = true,
        publishCompletedComparisons = false,
        traceComparisons = false,
        fallbackKind = null
      } = {}) {
        this.base = scorer(basePolicy);
        if (!responsePolicies.length) throw new Error("At least one opponent policy is required");
        this.responses = responsePolicies.map(scorer);
        this.horizons = Array.isArray(rolloutPlies) ? [...rolloutPlies] : [rolloutPlies];
        if (!this.horizons.length || this.horizons.some((n) => !Number.isInteger(n) || n < 0 || n > 48) || !(timeMs > 0) || !(nodeBudget > 0) || !Number.isFinite(minimumImprovement) || minimumImprovement < 0 || minimumImprovement > 1 || ![coverageWeight, reachWeight, valueTemperature].every(Number.isFinite) || coverageWeight < 0 || reachWeight < 0 || valueTemperature <= 0) throw new Error("Invalid rollout budget or value settings");
        Object.assign(this, {
          basePolicy,
          fallbackPolicy,
          fallbackMove,
          rootPriors,
          timeMs,
          minimumImprovement,
          coverageWeight,
          reachWeight,
          valueTemperature,
          nodeBudget,
          allowPass,
          reuseRootRanking,
          publishCompletedComparisons,
          traceComparisons,
          fallbackKind
        });
        this.lastSearch = null;
      }
      getTopMoves(source, player = source.currentPlayer, topN = 5) {
        if (!["territory-v2", "territory-v3"].includes(source.rulesVersion) || source.currentPlayer !== player)
          throw new Error("Invalid multiplayer rollout state");
        const started = performance.now(), deadline = this.absoluteDeadline ?? started + this.timeMs;
        const stats = this.lastSearch = {
          algorithm: "selfish-policy-rollout-heuristic-v2-natural-terminal-area",
          elapsedMs: 0,
          fallbackMs: 0,
          policyCandidates: 0,
          simulatedActions: 0,
          terminalLeaves: 0,
          evaluatedLeaves: 0,
          canonicalScoreCalls: 0,
          canonicalCacheHits: 0,
          heuristicLeaves: 0,
          nonterminalEvaluation: "multiplayer-heuristic-value-v2",
          terminalEvaluation: `native-${source.rulesVersion}`,
          heuristicSourceSha256: "53f1f6f6d515538d73e31393e814b7b2e02c0fde8093d30142c1aaa1222247fb",
          heuristicWeights: { nodes: 15 / 43, coverage: 8 / 43, reach: 20 / 43, temperature: 0.12 },
          completedPhases: [],
          legalRoots: 0,
          candidateCap: null,
          partialPhaseDiscarded: false,
          timedOut: false,
          usedFallback: true,
          fallbackBudgetExceeded: false,
          terminalScoringInterrupted: false,
          canonicalScoringInterrupted: false,
          reusedLinearRootRanking: false,
          rootPreparationMs: null,
          publicationMode: this.publishCompletedComparisons ? "completed-comparisons" : "complete-phase",
          fallbackKind: this.fallbackKind ?? (this.fallbackMove ? "supplied-move" : this.fallbackPolicy ? "base-policy" : "enumerated-linear"),
          decisionSource: "fallback",
          selectedEvaluation: "fallback-only",
          anytimePhases: [],
          completedRootComparisons: 0,
          acceptedPartialImprovements: 0,
          partialRootDiscarded: false,
          partialPhasePublished: false
        };
        if (source.gameOver || topN <= 0) return [];
        const engine = isolatedSearchEngine(source), root = saveState2(engine);
        const check2 = /* @__PURE__ */ __name(() => {
          if (performance.now() >= deadline || stats.policyCandidates + stats.simulatedActions >= this.nodeBudget) throw DEADLINE;
        }, "check");
        const apply = /* @__PURE__ */ __name((point) => point === null ? engine.skipTurn() : engine.playMove(point), "apply");
        const prior = /* @__PURE__ */ __name((point) => this.rootPriors?.get(key2(point)) ?? 0, "prior");
        const policyActions = /* @__PURE__ */ __name((score, ensureOne = false) => {
          const actor = engine.currentPlayer, candidates = [];
          visitPolicyCandidates(engine, actor, (candidate) => {
            const value = score(candidate.features), point = candidate.point;
            if (!Number.isFinite(value)) throw new Error("Nonfinite rollout policy score");
            candidates.push({ point, baseScore: value });
            if (ensureOne && (!fallback.length || value > fallback[0].score || value === fallback[0].score && order2({ point }, fallback[0]) < 0))
              fallback = [{ type: "move", point: [...point], score: value, baseScore: value, visits: 1 }];
          }, { beforeCandidate: /* @__PURE__ */ __name(() => {
            if (!ensureOne || candidates.length) check2();
            stats.policyCandidates++;
          }, "beforeCandidate") });
          return candidates.sort((a, b) => b.baseScore - a.baseScore || order2(a, b));
        }, "policyActions");
        const canonicalCache = /* @__PURE__ */ new Map();
        const canonicalAreas = /* @__PURE__ */ __name(() => {
          const identity2 = engine._computeStateHash(engine.currentPlayer);
          if (canonicalCache.has(identity2)) {
            stats.canonicalCacheHits++;
            return canonicalCache.get(identity2);
          }
          const index = engine._keyToIdx, originalGet = index.get;
          const descriptor = Object.getOwnPropertyDescriptor(index, "get");
          let probes = 0;
          index.get = function(k) {
            if ((++probes & 63) === 0) check2();
            return originalGet.call(this, k);
          };
          engine.cachedTerritories = { ...engine.cachedTerritories };
          try {
            check2();
            stats.canonicalScoreCalls++;
            GameEngine.prototype._updateTerritories.call(engine);
            check2();
          } catch (error) {
            if (error === DEADLINE) {
              stats.canonicalScoringInterrupted = true;
              stats.terminalScoringInterrupted = engine.gameOver;
            }
            throw error;
          } finally {
            if (descriptor) Object.defineProperty(index, "get", descriptor);
            else delete index.get;
          }
          const areas = Object.fromEntries(engine.activePlayers.map((p) => [p, engine.cachedTerritories[p].area]));
          canonicalCache.set(identity2, areas);
          return areas;
        }, "canonicalAreas");
        const leaf = /* @__PURE__ */ __name(() => {
          const alive = engine.activePlayers.filter((p) => !engine.resignedPlayers.has(p));
          if (!engine.gameOver) {
            check2();
            const metrics = multiplayerMetrics(engine);
            check2();
            const evaluated = evaluateNonterminalTeacher(metrics, player, alive, engine.validPositions.length, {
              nodeWeight: 15 / 43,
              coverageWeight: 8 / 43,
              reachWeight: 20 / 43,
              valueTemperature: 0.12
            });
            check2();
            stats.evaluatedLeaves++;
            stats.heuristicLeaves++;
            return { value: evaluated.heuristicValue, margin: evaluated.heuristicMargin, terminal: false };
          }
          const areas = canonicalAreas();
          const best = Math.max(...alive.map((p) => areas[p])), winners = alive.filter((p) => areas[p] === best);
          const margin = (areas[player] - Math.max(0, ...alive.filter((p) => p !== player).map((p) => areas[p]))) / engine.validPositions.length;
          stats.evaluatedLeaves++;
          stats.terminalLeaves++;
          return { value: winners.includes(player) ? 1 / winners.length : 0, margin, terminal: true };
        }, "leaf");
        let fallback = [], published = [], completeLinearRanking = null;
        try {
          if (this.fallbackMove) {
            const point = this.fallbackMove.point ?? null;
            if (!(point === null || engine._evaluateMove(point, player).legal)) throw new Error("Invalid supplied fallback move");
            fallback = [{ ...this.fallbackMove, point: point === null ? null : [...point] }];
          } else if (this.fallbackPolicy) {
            const fallbackStarted = performance.now();
            const contract = this.fallbackPolicy.fullRankingContract;
            if (this.reuseRootRanking && contract?.kind === "multiplayer-linear-full-ranking" && contract.version === 1 && contract.spec === this.basePolicy && typeof this.fallbackPolicy.getFullRanking === "function") {
              completeLinearRanking = this.fallbackPolicy.getFullRanking(isolatedSearchEngine(engine), player);
              fallback = completeLinearRanking.slice(0, Math.max(1, topN));
            } else fallback = this.fallbackPolicy.getTopMoves(isolatedSearchEngine(engine), player, Math.max(1, topN));
            stats.fallbackMs = performance.now() - fallbackStarted;
            stats.fallbackBudgetExceeded = performance.now() >= deadline;
            if (!fallback.length && !engine.getLegalMoves(player).length) fallback = [{ type: "pass", point: null, score: 0 }];
            if (completeLinearRanking) {
              const seen = /* @__PURE__ */ new Set();
              for (const move of completeLinearRanking) {
                if (move.point === null || !Number.isFinite(move.score) || seen.has(key2(move.point)))
                  throw new Error("Invalid complete linear ranking");
                seen.add(key2(move.point));
              }
            }
            const validationNodes = engine._getPlayerNodes(player), validationHashOrder = engine._getStateHashOrder();
            for (const move of fallback) {
              if (!(move.point === null || engine._evaluateMove(move.point, player, validationNodes, validationHashOrder).legal))
                throw new Error("Illegal fallback policy action");
            }
            check2();
            if (completeLinearRanking) {
              for (let index = fallback.length; index < completeLinearRanking.length; index++) {
                check2();
                if (!engine._evaluateMove(completeLinearRanking[index].point, player, validationNodes, validationHashOrder).legal)
                  throw new Error("Illegal fallback policy action");
              }
            }
            check2();
          }
          const roots = completeLinearRanking ? completeLinearRanking.map((move) => ({ point: [...move.point], baseScore: move.score })) : policyActions(this.base, !fallback.length);
          stats.reusedLinearRootRanking = completeLinearRanking !== null;
          if (!fallback.length) fallback = roots.map((move) => ({ ...move, score: move.baseScore, type: "move", visits: 1 }));
          if (this.allowPass || !roots.length) roots.push({ point: null, baseScore: -Infinity });
          if (!fallback.length) fallback = [{ type: "pass", point: null, score: 0, visits: 1 }];
          stats.legalRoots = roots.length;
          roots.sort((a, b) => prior(b.point) - prior(a.point) || b.baseScore - a.baseScore || order2(a, b));
          stats.rootPreparationMs = performance.now() - started;
          const fallbackKey = key2(fallback[0].point);
          const evaluateResponse = /* @__PURE__ */ __name((move, plies, responseIndex) => {
            check2();
            restoreState2(engine, root);
            if (!apply(move.point).success) throw new Error("Legal rollout root changed");
            const rootTerminal = engine.gameOver;
            stats.simulatedActions++;
            for (let ply = 0; ply < plies && !engine.gameOver; ply++) {
              check2();
              const policy = engine.currentPlayer === player ? this.base : this.responses[responseIndex];
              const action = policyActions(policy)[0]?.point ?? null;
              if (!apply(action).success) throw new Error("Illegal rollout continuation");
              stats.simulatedActions++;
            }
            const result = leaf();
            if (this.publishCompletedComparisons) check2();
            if (source.rulesVersion === "territory-v3" && rootTerminal && result.terminal && result.value === 1 && result.margin > 0 && engine._getRemainingPlayers().length >= 2)
              return { ...result, immediateTerminalWin: true };
            return result;
          }, "evaluateResponse");
          const scoredMove = /* @__PURE__ */ __name((move, total, count) => ({
            type: move.point === null ? "pass" : "move",
            point: move.point,
            score: total.value / count,
            margin: total.margin / count,
            baseScore: move.baseScore,
            prior: prior(move.point),
            visits: count,
            ...total.immediateTerminalWins === count ? { immediateTerminalWin: true } : {}
          }), "scoredMove");
          const rank = /* @__PURE__ */ __name((moves, incumbentKey) => {
            const ranked = [...moves].sort((a, b) => Number(b.immediateTerminalWin === true) - Number(a.immediateTerminalWin === true) || b.score - a.score || b.margin - a.margin || b.prior - a.prior || b.baseScore - a.baseScore || order2(a, b));
            const incumbent = ranked.find((move) => key2(move.point) === incumbentKey);
            if (incumbent && !(ranked[0].immediateTerminalWin === true && incumbent.immediateTerminalWin !== true) && ranked[0].score - incumbent.score < this.minimumImprovement) {
              ranked.splice(ranked.indexOf(incumbent), 1);
              ranked.unshift(incumbent);
            }
            return { ranked, incumbent };
          }, "rank");
          const recordPhase = /* @__PURE__ */ __name((plies, count, incumbent) => {
            stats.usedFallback = key2(published[0].point) === fallbackKey;
            stats.completedPhases.push({
              rolloutPlies: plies,
              responsePolicies: count,
              roots: roots.length,
              selectedPoint: published[0].point,
              score: published[0].score,
              incumbentPoint: incumbent?.point ?? null,
              incumbentScore: incumbent?.score ?? null,
              fallbackScore: published.find((move) => key2(move.point) === fallbackKey)?.score ?? null
            });
          }, "recordPhase");
          for (const plies of this.horizons) {
            if (!this.publishCompletedComparisons) {
              const totals = new Map(roots.map((move) => [key2(move.point), { value: 0, margin: 0 }]));
              for (let responseIndex = 0; responseIndex < this.responses.length; responseIndex++) {
                const values = [];
                for (const move of roots) values.push({ ...move, ...evaluateResponse(move, plies, responseIndex) });
                for (const value of values) {
                  const total = totals.get(key2(value.point));
                  total.value += value.value;
                  total.margin += value.margin;
                  if (value.immediateTerminalWin) total.immediateTerminalWins = (total.immediateTerminalWins ?? 0) + 1;
                }
                const count = responseIndex + 1;
                const incumbentKey = published.length ? key2(published[0].point) : fallbackKey;
                const result = rank(roots.map((move) => scoredMove(move, totals.get(key2(move.point)), count)), incumbentKey);
                published = result.ranked;
                recordPhase(plies, count, result.incumbent);
              }
              continue;
            }
            const results = new Map(roots.map((move) => [key2(move.point), []]));
            for (let responseIndex = 0; responseIndex < this.responses.length; responseIndex++) {
              const count = responseIndex + 1;
              const entryKey = published.length ? key2(published[0].point) : fallbackKey;
              const entryRoot = roots.find((move) => key2(move.point) === entryKey);
              if (!entryRoot) throw new Error("Phase incumbent missing from legal roots");
              const phase = {
                rolloutPlies: plies,
                responsePolicies: count,
                roots: roots.length,
                evaluatedRoots: 0,
                completed: false,
                entryIncumbentPoint: entryRoot.point,
                entryIncumbentScore: null,
                selectedPoint: entryRoot.point,
                selectedScore: null,
                acceptedImprovements: 0
              };
              if (this.traceComparisons) phase.comparisons = [];
              stats.anytimePhases.push(phase);
              const evaluate3 = /* @__PURE__ */ __name((move) => {
                const cached = results.get(key2(move.point));
                for (let variant = cached.length; variant < count; variant++)
                  cached.push(evaluateResponse(move, plies, variant));
                const total = { value: 0, margin: 0 };
                for (let variant = 0; variant < count; variant++) {
                  total.value += cached[variant].value;
                  total.margin += cached[variant].margin;
                  if (cached[variant].immediateTerminalWin) total.immediateTerminalWins = (total.immediateTerminalWins ?? 0) + 1;
                }
                check2();
                return scoredMove(move, total, count);
              }, "evaluate");
              const entry = evaluate3(entryRoot), evaluated = [entry];
              phase.entryIncumbentScore = entry.score;
              phase.evaluatedRoots = 1;
              published = rank(evaluated, entryKey).ranked;
              phase.selectedScore = entry.score;
              for (const move of roots) {
                if (key2(move.point) === entryKey) continue;
                const candidate = evaluate3(move);
                evaluated.push(candidate);
                phase.evaluatedRoots++;
                stats.completedRootComparisons++;
                const ranked = rank(evaluated, entryKey).ranked;
                const changed = key2(ranked[0].point) !== key2(published[0].point);
                if (this.traceComparisons) phase.comparisons.push({
                  point: candidate.point,
                  score: candidate.score,
                  margin: candidate.margin,
                  prior: candidate.prior,
                  baseScore: candidate.baseScore,
                  entryScore: entry.score,
                  selectedPoint: ranked[0].point,
                  selectedScore: ranked[0].score,
                  changed
                });
                if (changed) {
                  phase.acceptedImprovements++;
                  stats.acceptedPartialImprovements++;
                }
                published = ranked;
                phase.selectedPoint = ranked[0].point;
                phase.selectedScore = ranked[0].score;
                stats.usedFallback = key2(ranked[0].point) === fallbackKey;
              }
              phase.completed = true;
              recordPhase(plies, count, entry);
            }
          }
        } catch (error) {
          if (error !== DEADLINE) throw error;
          stats.timedOut = true;
          stats.partialPhaseDiscarded = true;
          if (this.publishCompletedComparisons) {
            stats.partialRootDiscarded = true;
            const phase = stats.anytimePhases.at(-1);
            stats.partialPhasePublished = Boolean(phase && !phase.completed && phase.acceptedImprovements > 0);
            stats.partialPhaseDiscarded = !stats.partialPhasePublished;
          }
        } finally {
          stats.elapsedMs = performance.now() - started;
        }
        stats.decisionSource = stats.usedFallback ? "fallback" : this.publishCompletedComparisons ? "completed-comparison" : "complete-phase";
        stats.selectedEvaluation = published.length ? this.publishCompletedComparisons ? "complete-response-prefix" : "complete-root-phase" : "fallback-only";
        return (published.length ? published : fallback).slice(0, topN);
      }
    };
  }
});

// application-hard:MultiplayerHardFallback.js
function linearRanking(engine, player, spec, check2, completed = []) {
  visitPolicyCandidates(engine, player, (candidate) => {
    const score = candidate.features.reduce((sum, value, i) => sum + value * spec.weights[i], 0) / (spec.temperature ?? 1);
    if (!Number.isFinite(score)) throw new Error("Invalid isolated Hard linear score");
    check2();
    completed.push({ point: candidate.point, score, visits: 1 });
  }, { beforeCandidate: check2 });
  check2();
  return finishLinear(completed);
}
function rankEvaluated(evaluated, baseline, minimumImprovement) {
  const ranked = [...evaluated].sort((a, b) => b.score - a.score || b.margin - a.margin || b.baseScore - a.baseScore || pointOrder2(a, b));
  const baseMove = ranked.find((move) => move.point.toString() === baseline.point.toString());
  if (!baseMove) throw new Error("Isolated v4 publication lacks a complete baseline");
  if (ranked[0].score - baseMove.score < minimumImprovement) {
    ranked.splice(ranked.indexOf(baseMove), 1);
    ranked.unshift(baseMove);
  }
  const values = ranked.map((move) => Math.exp(4 * move.score));
  const total = values.reduce((a, b) => a + b, 0);
  return ranked.map((move, i) => ({ ...move, prior: values[i] / total }));
}
function validateMoves(source, player, moves) {
  const native = isolatedSearchEngine(source);
  for (const move of moves) {
    if (move.point === null) {
      const passEngine = isolatedSearchEngine(source);
      if (!passEngine.skipTurn().success) throw new Error("Invalid isolated Hard deadline PASS");
    } else if (!native._evaluateMove(move.point, player).legal) {
      throw new Error("Invalid isolated Hard fallback placement");
    }
  }
}
var EXPIRED, pointOrder2, finishLinear, HardDeadlineFallbackV2;
var init_MultiplayerHardFallback = __esm({
  "application-hard:MultiplayerHardFallback.js"() {
    init_AIEngine();
    init_MultiplayerSearch();
    init_ThreePlayerSearchAI();
    EXPIRED = Symbol("isolated Hard v2 shared deadline");
    pointOrder2 = /* @__PURE__ */ __name((a, b) => a.point[1] - b.point[1] || a.point[0] - b.point[0], "pointOrder");
    finishLinear = /* @__PURE__ */ __name((candidates) => {
      const ranked = [...candidates].sort((a, b) => b.score - a.score || pointOrder2(a, b));
      const maximum = ranked[0]?.score ?? 0;
      const total = ranked.reduce((sum, move) => sum + Math.exp(move.score - maximum), 0);
      return ranked.map((move) => ({ ...move, prior: Math.exp(move.score - maximum) / total }));
    }, "finishLinear");
    __name(linearRanking, "linearRanking");
    __name(rankEvaluated, "rankEvaluated");
    __name(validateMoves, "validateMoves");
    HardDeadlineFallbackV2 = class {
      static {
        __name(this, "HardDeadlineFallbackV2");
      }
      constructor(spec, { searchV4 = false } = {}) {
        if (!Array.isArray(spec?.weights) || spec.weights.length !== 16 || !spec.weights.every(Number.isFinite) || !(Number.isFinite(spec.temperature ?? 1) && (spec.temperature ?? 1) > 0))
          throw new Error("Invalid isolated Hard fallback policy");
        if (searchV4) new ThreePlayerSearchAI(spec);
        this.spec = structuredClone(spec);
        this.searchV4 = searchV4;
        this.lastSearch = null;
        this.fullRanking = null;
      }
      getTopMoves(source, player = source.currentPlayer, topN = 5, { deadline = Infinity, now: now2 = /* @__PURE__ */ __name(() => performance.now(), "now") } = {}) {
        this.lastSearch = null;
        this.fullRanking = null;
        if (!["territory-v2", "territory-v3"].includes(source.rulesVersion) || player !== source.currentPlayer || ![3, 4, 5, 6].includes(source.playerCount) || this.searchV4 && source.playerCount !== 3 || Number.isNaN(deadline)) throw new Error("Invalid isolated Hard fallback state/budget");
        const started = now2();
        const stats = this.lastSearch = {
          algorithm: this.searchV4 ? "interruptible-original-v4" : "interruptible-original-linear",
          elapsedMs: 0,
          absoluteDeadline: deadline,
          baselineComplete: false,
          completed: false,
          partial: false,
          fallbackChanged: false,
          timedOut: false,
          decisionSource: null,
          simulatedActions: 0,
          simulations: 0,
          terminalLeaves: 0,
          canonicalScoreCalls: 0,
          canonicalScoringInterrupted: false,
          terminalScoringInterrupted: false,
          partialRootDiscarded: false,
          evaluated: [],
          baselineCandidatesCompleted: 0
        };
        if (source.gameOver || topN <= 0) {
          stats.completed = true;
          return [];
        }
        const engine = isolatedSearchEngine(source), snapshot = saveState2(engine);
        const check2 = /* @__PURE__ */ __name(() => {
          if (now2() >= deadline) throw EXPIRED;
        }, "check");
        const originalEvaluate = engine._evaluateMove, evaluateDescriptor = Object.getOwnPropertyDescriptor(engine, "_evaluateMove");
        engine._evaluateMove = function(...args) {
          check2();
          const result2 = originalEvaluate.apply(this, args);
          check2();
          return result2;
        };
        const baselineCandidates = [];
        let baseline = [], result = [], evaluatingRoot = false;
        const scoreLeaf = /* @__PURE__ */ __name(() => {
          const index = engine._keyToIdx, originalGet = index.get, descriptor = Object.getOwnPropertyDescriptor(index, "get");
          let probes = 0;
          index.get = function(key3) {
            if ((++probes & 63) === 0) check2();
            return originalGet.call(this, key3);
          };
          try {
            check2();
            stats.canonicalScoreCalls++;
            const leaf = positionUtilityV4(engine, player, this.spec.search);
            check2();
            return leaf;
          } catch (error) {
            if (error === EXPIRED) {
              stats.canonicalScoringInterrupted = true;
              stats.terminalScoringInterrupted = engine.gameOver;
            }
            throw error;
          } finally {
            if (descriptor) Object.defineProperty(index, "get", descriptor);
            else delete index.get;
          }
        }, "scoreLeaf");
        try {
          check2();
          baseline = linearRanking(engine, player, this.spec, check2, baselineCandidates);
          stats.baselineComplete = true;
          this.fullRanking = structuredClone(baseline);
          result = this.searchV4 ? baseline.slice(0, this.spec.search.rootWidth) : baseline;
          stats.decisionSource = "original-linear";
          if (!this.searchV4 || result.length <= 1) {
            stats.completed = true;
            stats.forcedMove = this.searchV4 && result.length === 1;
          } else {
            const roots = baseline.slice(0, this.spec.search.rootWidth), evaluated = [];
            for (const move of roots) {
              evaluatingRoot = true;
              const leaves = [];
              for (const opponent of this.spec.search.opponents) {
                check2();
                restoreState2(engine, snapshot);
                if (!engine.playMove(move.point).success) throw new Error("Invalid isolated v4 root action");
                check2();
                stats.simulatedActions++;
                for (let ply = 0; ply < this.spec.search.rolloutPlies && !engine.gameOver; ply++) {
                  check2();
                  const spec = engine.currentPlayer === player ? this.spec : opponent;
                  const reply = linearRanking(engine, engine.currentPlayer, spec, check2)[0]?.point ?? null;
                  if (!(reply ? engine.playMove(reply) : engine.skipTurn()).success) throw new Error("Invalid isolated v4 rollout action");
                  check2();
                  stats.simulatedActions++;
                }
                const leaf = scoreLeaf();
                leaves.push(leaf);
                stats.simulations++;
                stats.terminalLeaves += Number(leaf.terminal);
              }
              check2();
              evaluated.push({
                point: [...move.point],
                baseScore: move.score,
                score: leaves.reduce((sum, leaf) => sum + leaf.value, 0) / leaves.length,
                margin: leaves.reduce((sum, leaf) => sum + leaf.margin, 0) / leaves.length,
                leaves,
                visits: leaves.length
              });
              evaluatingRoot = false;
              result = rankEvaluated(evaluated, baseline[0], this.spec.search.minimumImprovement);
              stats.evaluated = structuredClone(result.map(({ prior, ...move2 }) => move2));
              stats.decisionSource = "completed-v4-comparisons";
            }
            stats.completed = true;
            stats.decisionSource = "original-v4-complete";
          }
        } catch (error) {
          if (error !== EXPIRED) throw error;
          stats.timedOut = true;
          stats.partial = true;
          stats.fallbackChanged = true;
          stats.partialRootDiscarded = evaluatingRoot;
          if (!stats.baselineComplete) {
            result = finishLinear(baselineCandidates);
            stats.decisionSource = result.length ? "partial-linear" : "deadline-pass";
          }
        } finally {
          if (evaluateDescriptor) Object.defineProperty(engine, "_evaluateMove", evaluateDescriptor);
          else delete engine._evaluateMove;
          restoreState2(engine, snapshot);
          stats.baselineCandidatesCompleted = baselineCandidates.length;
          stats.elapsedMs = now2() - started;
        }
        if (!result.length) {
          result = [{ type: "pass", point: null, score: 0, visits: 1 }];
          if (stats.baselineComplete) stats.decisionSource = "no-legal-placement";
        }
        const moves = result.slice(0, Math.max(0, Math.floor(topN)));
        validateMoves(source, player, moves);
        stats.elapsedMs = now2() - started;
        return moves;
      }
    };
  }
});

// application-hard:PortableClone.js
function portableClone(value) {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  const seen = /* @__PURE__ */ new Map();
  const clone = /* @__PURE__ */ __name((source) => {
    if (source === null || typeof source !== "object") {
      if (typeof source === "function" || typeof source === "symbol") throw new TypeError("Unsupported clone value");
      return source;
    }
    if (seen.has(source)) return seen.get(source);
    if (source instanceof ArrayBuffer) {
      const result2 = source.slice(0);
      seen.set(source, result2);
      return result2;
    }
    if (ArrayBuffer.isView(source)) {
      const buffer = clone(source.buffer);
      const result2 = source instanceof DataView ? new DataView(buffer, source.byteOffset, source.byteLength) : new source.constructor(buffer, source.byteOffset, source.length);
      seen.set(source, result2);
      return result2;
    }
    if (source instanceof Date) {
      const result2 = new Date(source.getTime());
      seen.set(source, result2);
      return result2;
    }
    if (source instanceof Map) {
      const result2 = /* @__PURE__ */ new Map();
      seen.set(source, result2);
      for (const [key3, item] of source) result2.set(clone(key3), clone(item));
      return result2;
    }
    if (source instanceof Set) {
      const result2 = /* @__PURE__ */ new Set();
      seen.set(source, result2);
      for (const item of source) result2.add(clone(item));
      return result2;
    }
    const result = Array.isArray(source) ? [] : {};
    seen.set(source, result);
    for (const key3 of Object.keys(source)) Object.defineProperty(
      result,
      key3,
      { value: clone(source[key3]), enumerable: true, writable: true, configurable: true }
    );
    return result;
  }, "clone");
  return clone(value);
}
var init_PortableClone = __esm({
  "application-hard:PortableClone.js"() {
    __name(portableClone, "portableClone");
  }
});

// application-hard:MultiplayerHardRuntime.js
function scanTacticalDirectCutRisk(source, roots, {
  deadline,
  now: now2 = /* @__PURE__ */ __name(() => multiplayerClock.now(), "now"),
  measurePlacementKeys = /* @__PURE__ */ new Set()
}) {
  const actor = source.currentPlayer, engine = isolatedSearchEngine(source), rootSnapshot = saveState2(engine);
  const stats = { complete: false, reason: null, probes: 0, rootsChecked: 0, terminalRoot: null, rows: [] };
  const STOP = Symbol("Hard tactical-ordering deadline");
  const check2 = /* @__PURE__ */ __name(() => {
    const time = now2();
    if (!Number.isFinite(time)) throw new Error("Invalid tactical-ordering clock");
    if (time >= deadline) throw STOP;
  }, "check");
  const evaluate3 = engine._evaluateMove;
  const descriptor = Object.getOwnPropertyDescriptor(engine, "_evaluateMove");
  engine._evaluateMove = function(...args) {
    check2();
    stats.probes++;
    const result = evaluate3.apply(this, args);
    check2();
    return result;
  };
  try {
    const enemies = engine.activePlayers.filter((player) => player !== actor && !engine.resignedPlayers.has(player));
    const enemyNodes = enemies.flatMap((player) => engine.validPositions.filter((point) => engine._getState(point) === engine._getPlayerStates(player).node).map((point) => ({ player, coordinate: pointKey4(point) })));
    const byPoint = /* @__PURE__ */ new Map();
    for (const root of roots) {
      check2();
      restoreState2(engine, rootSnapshot);
      stats.rootsChecked++;
      const outcome = root.point === null ? engine.skipTurn() : engine.playMove(root.point);
      check2();
      if (!outcome.success) throw new Error(`Illegal Hard tactical-order root: ${outcome.reason}`);
      if (engine.gameOver) {
        stats.complete = true;
        stats.reason = "terminal-requires-native-score";
        stats.terminalRoot = { point: copyPoint(root.point) };
        return { byPoint, stats };
      }
      if (root.kind === "placement" && !measurePlacementKeys.has(pointKey4(root.point))) continue;
      const own3 = engine._getPlayerStates(actor);
      const ownNodes = new Set(engine.validPositions.filter((point) => engine._getState(point) === own3.node).map(pointKey4));
      const ownCoverage = new Set(engine.validPositions.filter((point) => [own3.node, own3.line].includes(engine._getState(point))).map(pointKey4));
      const capturedNodes = enemyNodes.filter((row2) => engine.grid.get(row2.coordinate) !== engine._getPlayerStates(row2.player).node).length;
      const row = {
        point: copyPoint(root.point),
        replyPlayer: null,
        directCutReplies: 0,
        maximumNodeLoss: 0,
        maximumCoverageLoss: 0,
        capturedNodes,
        worstNetNodeGain: capturedNodes,
        terminalRoot: false
      };
      if (engine.currentPlayer !== actor) {
        row.replyPlayer = engine.currentPlayer;
        const replySnapshot = saveState2(engine);
        for (const reply of potentialMoves(engine, row.replyPlayer)) {
          check2();
          if (engine._getState(reply) !== own3.line) continue;
          stats.probes++;
          const replyOutcome = engine.playMove(reply);
          check2();
          if (!replyOutcome.success) {
            restoreState2(engine, replySnapshot);
            if (["INVALID_MOVE", "SUPERKO_VIOLATION"].includes(replyOutcome.reason)) continue;
            throw new Error(`Illegal Hard tactical-order reply: ${replyOutcome.reason}`);
          }
          row.directCutReplies++;
          const connected = engine._getOpponentConnectedPieces(actor);
          const retainedNodes = [...ownNodes].filter((coordinate) => connected.has(coordinate) && engine.grid.get(coordinate) === own3.node).length;
          const retainedCoverage = [...ownCoverage].filter((coordinate) => connected.has(coordinate) && [own3.node, own3.line].includes(engine.grid.get(coordinate))).length;
          row.maximumNodeLoss = Math.max(row.maximumNodeLoss, ownNodes.size - retainedNodes);
          row.maximumCoverageLoss = Math.max(row.maximumCoverageLoss, ownCoverage.size - retainedCoverage);
          restoreState2(engine, replySnapshot);
        }
      }
      row.worstNetNodeGain = row.capturedNodes - row.maximumNodeLoss;
      stats.rows.push(row);
      byPoint.set(pointKey4(root.point), row);
    }
    check2();
    stats.complete = true;
    stats.reason = "complete";
    return { byPoint, stats };
  } catch (error) {
    if (error !== STOP) throw error;
    stats.reason = "deadline";
    return { byPoint: /* @__PURE__ */ new Map(), stats };
  } finally {
    restoreState2(engine, rootSnapshot);
    if (descriptor) Object.defineProperty(engine, "_evaluateMove", descriptor);
    else delete engine._evaluateMove;
  }
}
function preflightImmediateTerminalRoots(source, roots, { deadline, now: now2 = /* @__PURE__ */ __name(() => multiplayerClock.now(), "now") }) {
  const stats = { complete: false, terminalRoot: null, attemptedRoots: 0, reason: null };
  const engine = isolatedSearchEngine(source), snapshot = saveState2(engine), STOP = Symbol("terminal preflight deadline");
  const check2 = /* @__PURE__ */ __name(() => {
    const time = now2();
    if (!Number.isFinite(time)) throw new Error("Invalid terminal preflight clock");
    if (time >= deadline) throw STOP;
  }, "check");
  const evaluate3 = engine._evaluateMove, descriptor = Object.getOwnPropertyDescriptor(engine, "_evaluateMove");
  engine._evaluateMove = function(...args) {
    check2();
    const value = evaluate3.apply(this, args);
    check2();
    return value;
  };
  try {
    for (const root of roots) {
      check2();
      stats.attemptedRoots++;
      const outcome = root.point === null ? engine.skipTurn() : engine.playMove(root.point);
      check2();
      if (!outcome.success) throw new Error(`Illegal Hard terminal preflight root: ${outcome.reason}`);
      if (engine.gameOver) {
        stats.terminalRoot = { point: copyPoint(root.point) };
        stats.reason = "terminal-requires-native-score";
        return stats;
      }
      restoreState2(engine, snapshot);
    }
    check2();
    stats.complete = true;
    stats.reason = "complete";
    return stats;
  } catch (error) {
    if (error !== STOP) throw error;
    stats.reason = "deadline";
    return stats;
  } finally {
    if (descriptor) Object.defineProperty(engine, "_evaluateMove", descriptor);
    else delete engine._evaluateMove;
  }
}
function selectCompleteReplyResilience(source, {
  anchor,
  fullRanking,
  deadline,
  windowMs = HARD_REPLY_WINDOW_MS,
  now: now2 = /* @__PURE__ */ __name(() => multiplayerClock.now(), "now"),
  probe = probeMultiplayerReplyResilience,
  preflight = preflightImmediateTerminalRoots
} = {}) {
  const started = now2(), end = Math.min(deadline, started + windowMs);
  const stats = {
    scope: responseScope,
    windowMs,
    absoluteDeadline: end,
    elapsedMs: 0,
    reason: "no-complete-ranking",
    accepted: false,
    selected: null,
    anchor: null,
    candidateReachability: [],
    attemptedRoots: [],
    completedRoots: [],
    followupAttempts: [],
    partialRootDiscarded: false,
    completeRootDomain: false,
    orderingRiskScan: null,
    terminalPreflight: null
  };
  let selected = null, anchorPacket = null;
  try {
    if (!Number.isFinite(started) || !Number.isFinite(deadline) || !Number.isFinite(windowMs) || windowMs < 0) throw new Error("Invalid Hard reply deadline");
    if (!anchor || !Array.isArray(fullRanking)) return { moves: null, stats };
    const roots = [...fullRanking];
    if (!roots.some((move) => move.point === null)) roots.push({ point: null });
    if (!roots.some((move) => pointKey4(move.point) === pointKey4(anchor.point)))
      throw new Error("Hard reply anchor missing from complete root domain");
    const own3 = source._getPlayerStates(source.currentPlayer);
    const enemyLines = new Set(source._getOpponents(source.currentPlayer).map((player) => source._getPlayerStates(player).line));
    const kind = /* @__PURE__ */ __name((point) => point === null ? "pass" : enemyLines.has(source._getState(point)) ? "attack" : source._getState(point) === own3.line ? "reinforcement" : "placement", "kind");
    const indexed = roots.map((move, rank) => ({ point: copyPoint(move.point), rank, kind: kind(move.point) }));
    const anchorRoot = indexed.find((move) => pointKey4(move.point) === pointKey4(anchor.point));
    const others = indexed.filter((move) => move !== anchorRoot);
    const provisionalOrder = [
      anchorRoot,
      ...others.filter((move) => move.kind === "pass"),
      ...others.filter((move) => move.kind !== "pass")
    ];
    stats.candidateReachability = provisionalOrder.map((move, visitOrder) => ({
      ...move,
      visitOrder,
      directCutPriority: false,
      directCutRisk: null
    }));
    const riskScan = scanTacticalDirectCutRisk(source, indexed, {
      deadline: end,
      now: now2,
      measurePlacementKeys: /* @__PURE__ */ new Set([pointKey4(anchorRoot.point)])
    });
    stats.orderingRiskScan = riskScan.stats;
    if (!riskScan.stats.complete) {
      stats.reason = riskScan.stats.reason;
      return { moves: null, stats };
    }
    if (riskScan.stats.terminalRoot !== null) {
      stats.terminalPreflight = {
        complete: false,
        terminalRoot: riskScan.stats.terminalRoot,
        attemptedRoots: riskScan.stats.rootsChecked,
        reason: "terminal-requires-native-score",
        reusedOrderingScan: true
      };
      stats.reason = "terminal-requires-native-score";
      return { moves: null, stats };
    }
    const risk = /* @__PURE__ */ __name((move) => riskScan.byPoint.get(pointKey4(move.point)), "risk");
    const compareDirectRisk = /* @__PURE__ */ __name((left, right) => left.maximumNodeLoss - right.maximumNodeLoss || right.worstNetNodeGain - left.worstNetNodeGain || left.maximumCoverageLoss - right.maximumCoverageLoss, "compareDirectRisk");
    const rankedTactical = others.filter((move) => move.kind !== "placement" && move.kind !== "pass").sort((left, right) => compareDirectRisk(risk(left), risk(right)) || left.rank - right.rank);
    const priority = rankedTactical.find((move) => compareDirectRisk(risk(move), risk(anchorRoot)) < 0) ?? null;
    const passes = others.filter((move) => move.kind === "pass");
    const ordered = [
      anchorRoot,
      ...priority ? [priority] : [],
      ...passes,
      ...rankedTactical.filter((move) => move !== priority),
      ...others.filter((move) => move.kind === "placement")
    ];
    if (new Set(ordered.map((move) => pointKey4(move.point))).size !== ordered.length)
      throw new Error("Duplicate Hard reply roots");
    stats.candidateReachability = ordered.map((move, visitOrder) => ({
      ...move,
      visitOrder,
      directCutPriority: move === priority,
      directCutRisk: riskScan.byPoint.has(pointKey4(move.point)) ? {
        maximumNodeLoss: risk(move).maximumNodeLoss,
        maximumCoverageLoss: risk(move).maximumCoverageLoss,
        worstNetNodeGain: risk(move).worstNetNodeGain,
        directCutReplies: risk(move).directCutReplies
      } : null
    }));
    stats.terminalPreflight = preflight === preflightImmediateTerminalRoots ? {
      complete: true,
      terminalRoot: null,
      attemptedRoots: riskScan.stats.rootsChecked,
      reason: "complete",
      reusedOrderingScan: true
    } : preflight(source, ordered, { deadline: end, now: now2 });
    if (!stats.terminalPreflight.complete || stats.terminalPreflight.terminalRoot !== null) {
      stats.reason = stats.terminalPreflight.reason;
      return { moves: null, stats };
    }
    stats.reason = "no-strict-improvement";
    for (const root of ordered) {
      const remaining = end - now2();
      if (remaining <= 0) {
        stats.reason = "deadline";
        break;
      }
      const attempt = { point: copyPoint(root.point), rank: root.rank, kind: root.kind, complete: false };
      stats.attemptedRoots.push(attempt);
      let packet = probe(source, root.point, {
        deadline: end,
        timeMs: remaining,
        now: now2,
        maxReplies: source.validPositions.length + 1,
        maxProbes: 16384,
        followupMode: "none"
      });
      Object.assign(attempt, {
        complete: packet.complete && packet.reason === "complete",
        reason: packet.reason,
        repliesCompleted: packet.repliesCompleted,
        probes: packet.probes
      });
      if (packet.terminalRoot) {
        selected = null;
        stats.reason = "terminal-requires-native-score";
        break;
      }
      if (!attempt.complete) {
        stats.partialRootDiscarded = true;
        if (!stats.anchor || packet.reason === "deadline") {
          stats.reason = packet.reason;
          break;
        }
        continue;
      }
      compareCompletedReplyResilience(packet, packet);
      if (pointKey4(packet.rootPoint) !== pointKey4(root.point) || packet.player !== source.currentPlayer)
        throw new Error("Hard reply packet belongs to another root or actor");
      const summary = packetSummary(packet);
      stats.completedRoots.push(summary);
      if (!stats.anchor) {
        stats.anchor = summary;
        selected = packet;
        anchorPacket = packet;
      } else {
        let comparison = compareCompletedReplyResilience(packet, selected, { anchor: anchorPacket });
        const defenseTied = ["maximumNodeLoss", "maximumCoverageLoss", "worstNetNodeGain", "allRepliesRetainAttackNode"].every((name) => packet[name] === selected[name]);
        if (comparison === 0 && defenseTied && packet.rootWasAttack && selected.rootWasAttack && packet.allRepliesRetainAttackNode && packet.minimumRetainedCapturedNodes > 0) {
          const extend = /* @__PURE__ */ __name((prior) => {
            if (prior.conditionalFollowupComplete || now2() >= end) return prior;
            const extended = probe(source, prior.rootPoint, {
              deadline: end,
              timeMs: Math.max(0, end - now2()),
              now: now2,
              maxReplies: source.validPositions.length + 1,
              maxProbes: 16384,
              followupMode: "minimum"
            });
            stats.followupAttempts.push({
              point: copyPoint(prior.rootPoint),
              complete: extended.complete,
              reason: extended.reason,
              repliesCompleted: extended.repliesCompleted
            });
            if (!extended.complete || extended.reason !== "complete") {
              stats.partialRootDiscarded = true;
              return prior;
            }
            compareCompletedReplyResilience(extended, extended);
            if (pointKey4(extended.rootPoint) !== pointKey4(prior.rootPoint) || extended.player !== prior.player || ["maximumNodeLoss", "maximumCoverageLoss", "worstNetNodeGain", "allRepliesRetainAttackNode"].some((name) => extended[name] !== prior[name])) throw new Error("Conditional replay changed complete defense packet");
            return extended;
          }, "extend");
          selected = extend(selected);
          if (selected.conditionalFollowupComplete) packet = extend(packet);
          comparison = compareCompletedReplyResilience(packet, selected, { anchor: anchorPacket });
        }
        if (comparison > 0) selected = packet;
      }
    }
    stats.completeRootDomain = stats.completedRoots.length === ordered.length;
    stats.accepted = selected !== null && pointKey4(selected.rootPoint) !== pointKey4(anchor.point);
    stats.selected = selected ? packetSummary(selected) : null;
    if (stats.accepted && stats.reason === "no-strict-improvement") stats.reason = "complete-improvement";
    if (!stats.accepted) return { moves: null, stats };
    return { moves: [{
      type: selected.rootPoint === null ? "pass" : "move",
      point: copyPoint(selected.rootPoint),
      score: selected.minimumDefenseSignal,
      prior: 1,
      visits: selected.repliesCompleted,
      evaluation: "complete-next-opponent-resilience"
    }], stats };
  } catch (error) {
    stats.reason = "error";
    stats.error = { name: error.name, message: error.message };
    stats.accepted = false;
    stats.selected = null;
    return { moves: null, stats };
  } finally {
    stats.elapsedMs = now2() - started;
  }
}
function createHardRuntimeV2(engine, medium) {
  if (![3, 4, 5, 6].includes(engine.playerCount) || !Number.isInteger(engine.gridSize) || engine.gridSize < 5 || engine.gridSize > 15 || !["territory-v2", "territory-v3"].includes(engine.rulesVersion) || engine.boardShape !== (engine.playerCount === 3 ? "triangle" : "hexagon"))
    throw new Error("Unsupported isolated Hard v2 experiment configuration");
  const fallback = new HardDeadlineFallbackV2(medium.policySpec, {
    searchV4: medium.modelInfo.id === "three-player-search-v4-round12"
  });
  const ai = {
    ...HARD_EXPERIMENT_OPTIONS,
    lastSearch: null,
    fallbackPolicy: fallback,
    getTopMoves(source, player = source.currentPlayer, topN = 5, options = {}) {
      const started = multiplayerClock.now(), deadline = Math.min(
        started + this.timeMs,
        Number.isFinite(options.deadline) ? options.deadline : Infinity
      );
      this.lastSearch = {
        algorithm: "hard-complete-next-opponent-resilience-v1",
        elapsedMs: 0,
        absoluteDeadline: deadline,
        fallbackChanged: false,
        partial: false,
        baselineComplete: false
      };
      if (source.gameOver || topN <= 0) return [];
      let search = null, tactical = null;
      try {
        const moves = fallback.getTopMoves(source, player, Math.max(1, topN), { deadline });
        if (moves.length && typeof options.onProgress === "function") options.onProgress(moves[0]);
        const fallbackMs = multiplayerClock.now() - started;
        if (multiplayerClock.now() >= deadline) {
          this.lastSearch = {
            ...this.lastSearch,
            fallbackMs,
            usedFallback: true,
            timedOut: true,
            legalRoots: null,
            completedRootComparisons: 0,
            completedPhases: [],
            selectedEvaluation: "fallback-only",
            decisionSource: fallback.lastSearch.decisionSource
          };
          return moves;
        }
        if (fallback.lastSearch.baselineComplete) {
          tactical = selectCompleteReplyResilience(source, {
            anchor: moves[0],
            fullRanking: fallback.fullRanking,
            deadline
          });
          if (tactical.moves) {
            this.lastSearch = {
              ...this.lastSearch,
              fallbackMs,
              usedFallback: false,
              selectedEvaluation: "complete-next-opponent-resilience",
              decisionSource: "completed-reply-resilience-comparisons",
              legalRoots: tactical.stats.candidateReachability.length,
              completedRootComparisons: Math.max(0, tactical.stats.completedRoots.length - 1),
              completedPhases: []
            };
            const selectedKey = pointKey4(tactical.moves[0].point);
            return [...tactical.moves, ...moves.filter((move) => pointKey4(move.point) !== selectedKey)].slice(0, Math.max(1, Math.floor(topN)));
          }
        }
        const readyFallback = { getTopMoves: /* @__PURE__ */ __name(() => moves, "getTopMoves") };
        if (!fallback.searchV4 && fallback.lastSearch.baselineComplete) {
          readyFallback.fullRankingContract = { kind: "multiplayer-linear-full-ranking", version: 1, spec: medium.policySpec };
          readyFallback.getFullRanking = () => fallback.fullRanking;
        }
        search = new MultiplayerRolloutAI({
          basePolicy: medium.policySpec,
          responsePolicies: [medium.policySpec],
          fallbackPolicy: readyFallback,
          timeMs: this.timeMs,
          rolloutPlies: [12, 24],
          publishCompletedComparisons: true
        });
        search.absoluteDeadline = deadline;
        const result = search.getTopMoves(source, player, topN);
        this.lastSearch = {
          ...search.lastSearch,
          absoluteDeadline: deadline,
          fallbackMs,
          decisionSource: search.lastSearch.selectedEvaluation === "fallback-only" ? fallback.lastSearch.decisionSource : search.lastSearch.decisionSource
        };
        return result;
      } catch (error) {
        this.lastSearch.error = { name: error.name, message: error.message };
        throw error;
      } finally {
        const details = fallback.lastSearch;
        this.lastSearch = {
          ...this.lastSearch,
          algorithm: "hard-complete-next-opponent-resilience-v1",
          elapsedMs: multiplayerClock.now() - started,
          fallbackSearch: portableClone(details),
          tacticalSearch: tactical?.stats ?? null,
          baselineComplete: details?.baselineComplete ?? false,
          fallbackChanged: details?.fallbackChanged ?? false,
          partial: Boolean(details?.partial || search?.lastSearch?.timedOut || this.lastSearch.timedOut),
          timedOut: Boolean(details?.timedOut || this.lastSearch.timedOut)
        };
      }
    }
  };
  return { ai, modelInfo: {
    implementationId: "multiplayer-hard-cut-resilience-v1",
    baseSourceManifestSha256: "8d89b9074be7a79b706a345eedfeda2d174337061e9424ebe8ff526ba41668bc",
    evidenceTier: "unqualified-application-algorithm-candidate",
    lineage: medium.modelInfo.id,
    nonterminalEvaluation: "multiplayer-heuristic-value-v2",
    terminalEvaluation: `native-${engine.rulesVersion}`,
    publicationMode: "completed-comparisons",
    absoluteDeadlineMs: 650,
    tacticalAlgorithm: "lexicographic-complete-next-opponent-resilience-v1",
    responseScope,
    fallbackPolicy: "interruptible-original-v4-or-linear; explicit-partial-linear-or-deadline-pass",
    strengthPreservationClaim: false
  } };
}
var HARD_EXPERIMENT_OPTIONS, HARD_REPLY_WINDOW_MS, pointKey4, copyPoint, responseScope, packetSummary;
var init_MultiplayerHardRuntime = __esm({
  "application-hard:MultiplayerHardRuntime.js"() {
    init_MultiplayerHardRollout();
    init_MultiplayerHardFallback();
    init_MultiplayerSearch();
    init_MultiplayerHardValue();
    init_AIEngine();
    init_MultiplayerClock();
    init_PortableClone();
    HARD_EXPERIMENT_OPTIONS = Object.freeze({
      timeMs: 650,
      rolloutPlies: Object.freeze([12, 24]),
      minimumImprovement: 0.02,
      candidateCap: null,
      allowPass: true,
      rootPriors: null
    });
    HARD_REPLY_WINDOW_MS = 220;
    pointKey4 = /* @__PURE__ */ __name((point) => point === null ? "PASS" : point.join(","), "pointKey");
    copyPoint = /* @__PURE__ */ __name((point) => point === null ? null : [...point], "copyPoint");
    responseScope = "one-actual-next-opponent; conditional-actor-followup; topology-signal-only";
    packetSummary = /* @__PURE__ */ __name((packet) => ({
      point: copyPoint(packet.rootPoint),
      replyPlayer: packet.replyPlayer,
      repliesCompleted: packet.repliesCompleted,
      maximumNodeLoss: packet.maximumNodeLoss,
      maximumCoverageLoss: packet.maximumCoverageLoss,
      rootWasAttack: packet.rootWasAttack,
      allRepliesRetainAttackNode: packet.allRepliesRetainAttackNode,
      minimumFollowupCutNodes: packet.minimumFollowupCutNodes,
      allRepliesRetainFollowupCut: packet.allRepliesRetainFollowupCut,
      conditionalFollowupComplete: packet.conditionalFollowupComplete,
      minimumRetainedCapturedNodes: packet.minimumRetainedCapturedNodes,
      worstNetNodeGain: packet.worstNetNodeGain,
      minimumDefenseSignal: packet.minimumDefenseSignal
    }), "packetSummary");
    __name(scanTacticalDirectCutRisk, "scanTacticalDirectCutRisk");
    __name(preflightImmediateTerminalRoots, "preflightImmediateTerminalRoots");
    __name(selectCompleteReplyResilience, "selectCompleteReplyResilience");
    __name(createHardRuntimeV2, "createHardRuntimeV2");
  }
});

// application-hard:MultiplayerHardResources.js
function supportsNativeHardContext(source) {
  return Boolean(source && [3, 4, 5, 6].includes(source.playerCount) && Number.isInteger(source.gridSize) && source.gridSize >= 5 && source.gridSize <= 15 && source.boardShape === (source.playerCount === 3 ? "triangle" : "hexagon") && ["territory-v2", "territory-v3"].includes(source.rulesVersion));
}
async function prepareHardResources(source) {
  if (!supportsNativeHardContext(source)) throw new Error("Unsupported native Hard AI configuration");
  const { playerCount, gridSize, boardShape, rulesVersion } = source;
  const context = { playerCount, gridSize, boardShape, rulesVersion };
  const key3 = JSON.stringify(context), started = performance.now(), reused = prepared.has(key3);
  if (!reused) {
    const promise = (async () => {
      if (playerCount === 3) {
        const { loadThreePlayerRuntime: loadThreePlayerRuntime2 } = await Promise.resolve().then(() => (init_ThreePlayerRuntime(), ThreePlayerRuntime_exports));
        const id = threePlayerModelIdForBoard(gridSize);
        const runtime = await loadThreePlayerRuntime2(id, context);
        if (runtime.modelInfo.id !== id) throw new Error("Three-player resource identity changed");
        return {
          policySpec: runtime.ai.base ? runtime.ai.spec : runtime.ai.model.spec,
          modelInfo: { id: runtime.modelInfo.id }
        };
      }
      const { loadHexPlayerModel: loadHexPlayerModel2 } = await Promise.resolve().then(() => (init_HexPlayerAI(), HexPlayerAI_exports));
      const model = await loadHexPlayerModel2();
      if (model.spec.id !== "hex-player-policy-v1") throw new Error("Hex resource identity changed");
      return { policySpec: model.spec, modelInfo: { id: model.spec.id } };
    })().catch((error) => {
      if (prepared.get(key3) === promise) prepared.delete(key3);
      throw error;
    });
    prepared.set(key3, promise);
  }
  return {
    medium: structuredClone(await prepared.get(key3)),
    context,
    resourceWaitMs: performance.now() - started,
    resourcePromiseReused: reused
  };
}
async function loadNativeHardRuntime(engine) {
  const loaderEnteredMs = performance.now(), loaded = await prepareHardResources(engine);
  const started = performance.now(), runtime = createHardRuntimeV2(engine, loaded.medium);
  return { ai: runtime.ai, modelInfo: {
    ...runtime.modelInfo,
    id: HARD_MODEL_ID,
    compatibility: `${engine.rulesVersion} native 3\u20136 players; size 5\u201315`,
    startup: {
      loaderEnteredMs,
      resourceWaitMs: loaded.resourceWaitMs,
      resourcePromiseReused: loaded.resourcePromiseReused,
      factoryMs: performance.now() - started,
      mediumPolicyId: loaded.medium.modelInfo.id,
      implementation: "native-hard-minimal-resources-v1"
    }
  } };
}
var HARD_MODEL_ID, prepared;
var init_MultiplayerHardResources = __esm({
  "application-hard:MultiplayerHardResources.js"() {
    init_MultiplayerHardRuntime();
    init_ThreePlayerSearchOptions();
    HARD_MODEL_ID = "multiplayer-hard-v1";
    prepared = /* @__PURE__ */ new Map();
    __name(supportsNativeHardContext, "supportsNativeHardContext");
    __name(prepareHardResources, "prepareHardResources");
    __name(loadNativeHardRuntime, "loadNativeHardRuntime");
  }
});

// application-hard:MultiplayerHardWorkerRuntime.js
var MultiplayerHardWorkerRuntime_exports = {};
__export(MultiplayerHardWorkerRuntime_exports, {
  loadMultiplayerRuntime: () => loadMultiplayerRuntime
});
async function loadMultiplayerRuntime(modelId, engine) {
  if (modelId === HARD_MODEL_ID && supportsNativeHardContext(engine)) return loadNativeHardRuntime(engine);
  const general = await import("./MultiplayerRuntime.js?v=20261029-unified-r1");
  return general.loadMultiplayerRuntime(modelId, engine);
}
var init_MultiplayerHardWorkerRuntime = __esm({
  "application-hard:MultiplayerHardWorkerRuntime.js"() {
    init_MultiplayerHardResources();
    __name(loadMultiplayerRuntime, "loadMultiplayerRuntime");
  }
});

// application-hard:MultiplayerAIWarmup.js
var MultiplayerAIWarmup_exports = {};
__export(MultiplayerAIWarmup_exports, {
  MultiplayerWarmupSession: () => MultiplayerWarmupSession,
  createMultiplayerWarmupLoader: () => createMultiplayerWarmupLoader,
  warmMultiplayerResources: () => warmMultiplayerResources
});
function createMultiplayerWarmupLoader(importRuntime = () => Promise.resolve().then(() => (init_MultiplayerHardWorkerRuntime(), MultiplayerHardWorkerRuntime_exports))) {
  const pending2 = /* @__PURE__ */ new Map();
  return (message) => {
    const context = contextOf(message?.context);
    if (message?.type !== "WARMUP" || !supported(message) || !context) return Promise.resolve(false);
    const key3 = identity(message.modelId, context);
    if (pending2.has(key3)) return pending2.get(key3);
    const promise = Promise.resolve().then(importRuntime).then(async ({ loadMultiplayerRuntime: loadMultiplayerRuntime2 }) => {
      const runtime = await loadMultiplayerRuntime2(message.modelId, context);
      if (runtime?.modelInfo?.id !== message.modelId) throw new Error("Multiplayer warmup model identity mismatch");
      return true;
    }).catch((error) => {
      if (pending2.get(key3) === promise) pending2.delete(key3);
      throw error;
    });
    pending2.set(key3, promise);
    return promise;
  };
}
var MODEL_IDS, contextOf, supported, identity, MultiplayerWarmupSession, warmMultiplayerResources;
var init_MultiplayerAIWarmup = __esm({
  "application-hard:MultiplayerAIWarmup.js"() {
    MODEL_IDS = /* @__PURE__ */ new Set(["multiplayer-easy-v1", "multiplayer-medium-v1", "multiplayer-hard-v1", "multiplayer-ultimate-v1"]);
    contextOf = /* @__PURE__ */ __name((value) => {
      if (!value || !Number.isInteger(value.playerCount) || value.playerCount < 3 || value.playerCount > 6 || !Number.isInteger(value.gridSize) || value.gridSize < 5 || value.gridSize > 15 || !["triangle", "diamond", "hexagon"].includes(value.boardShape) || !["territory-v2", "territory-v3"].includes(value.rulesVersion)) return null;
      return { playerCount: value.playerCount, gridSize: value.gridSize, boardShape: value.boardShape, rulesVersion: value.rulesVersion };
    }, "contextOf");
    supported = /* @__PURE__ */ __name((profile) => profile?.strategy === "multiplayer" && MODEL_IDS.has(profile.modelId), "supported");
    identity = /* @__PURE__ */ __name((modelId, context) => JSON.stringify([modelId, context.playerCount, context.gridSize, context.boardShape, context.rulesVersion]), "identity");
    MultiplayerWarmupSession = class {
      static {
        __name(this, "MultiplayerWarmupSession");
      }
      constructor() {
        this.sent = /* @__PURE__ */ new WeakMap();
      }
      hasRequested(worker) {
        return this.sent.has(worker);
      }
      request({ started, allowed, humanTurn, idle, context: sourceContext, profiles, ensureWorker } = {}) {
        if (!started || !allowed || !humanTurn || !idle) return 0;
        const context = contextOf(sourceContext);
        if (!context || !Array.isArray(profiles) || typeof ensureWorker !== "function") return 0;
        const modelIds = [...new Set(profiles.filter(supported).map((profile) => profile.modelId))];
        if (!modelIds.length) return 0;
        let worker;
        try {
          worker = ensureWorker();
        } catch (_) {
          return 0;
        }
        if (!worker || typeof worker.postMessage !== "function") return 0;
        let sent = this.sent.get(worker);
        if (!sent) {
          sent = /* @__PURE__ */ new Set();
          this.sent.set(worker, sent);
        }
        let count = 0;
        for (const modelId of modelIds) {
          const key3 = identity(modelId, context);
          if (sent.has(key3)) continue;
          try {
            worker.postMessage({ type: "WARMUP", strategy: "multiplayer", modelId, context });
            sent.add(key3);
            count++;
          } catch (_) {
          }
        }
        return count;
      }
    };
    __name(createMultiplayerWarmupLoader, "createMultiplayerWarmupLoader");
    warmMultiplayerResources = createMultiplayerWarmupLoader();
  }
});

// application-hard:BoardDefinition.js
function compareStableIdentifiers(left, right) {
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
  return Object.entries(value).every(([key3, child]) => isProtocolIdentifier(key3) && hasProtocolSafeObjectKeys(child));
}
function edgeOccurrenceId(faceId, sideIndex) {
  return String(faceId) + ":" + sideIndex;
}
function splitEdgeOccurrenceId(id) {
  if (typeof id !== "string") return null;
  const separator = id.lastIndexOf(":");
  if (separator <= 0) return null;
  const faceId = id.slice(0, separator);
  const sideIndex = Number(id.slice(separator + 1));
  return Number.isInteger(sideIndex) && sideIndex >= 0 ? { faceId, sideIndex } : null;
}
function undirectedKey(left, right) {
  return String(left) < String(right) ? String(left) + "|" + String(right) : String(right) + "|" + String(left);
}
function triangularDirectionIndex(fromCoordinate, toCoordinate) {
  if (!Array.isArray(fromCoordinate) || !Array.isArray(toCoordinate)) return -1;
  const dx = toCoordinate[0] - fromCoordinate[0];
  const dy = toCoordinate[1] - fromCoordinate[1];
  return TRIANGULAR_UNIT_DIRECTIONS.findIndex(([x, y]) => x === dx && y === dy);
}
function makeBoardError(code, location, detail = "") {
  return { code, location, detail };
}
function addError(errors, code, location, detail = "") {
  errors.push(makeBoardError(code, location, detail));
}
function mergeLimits(limits = {}) {
  const merged = { ...DEFAULT_BOARD_LIMITS };
  if (isPlainObject(limits)) {
    for (const [key3, value] of Object.entries(limits)) {
      if (own(merged, key3) && Number.isInteger(value) && value > 0) merged[key3] = value;
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
  return (right[0] - left[0]) * (top[1] - left[1]) - (right[1] - left[1]) * (top[0] - left[0]);
}
function buildOccurrences(faces) {
  const occurrences = [];
  const byId = /* @__PURE__ */ new Map();
  const byRawEdge = /* @__PURE__ */ new Map();
  for (const face of faces) {
    for (let sideIndex = 0; sideIndex < face.vertices.length; sideIndex += 1) {
      const vertices = [face.vertices[sideIndex], face.vertices[(sideIndex + 1) % face.vertices.length]];
      const occurrence = {
        id: edgeOccurrenceId(face.id, sideIndex),
        faceId: face.id,
        sideIndex,
        vertices,
        rawEdgeKey: undirectedKey(vertices[0], vertices[1])
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
  const adjacency = new Map(vertexIds.map((id) => [id, /* @__PURE__ */ new Set()]));
  for (const occurrence of occurrences) {
    const [left, right] = occurrence.vertices;
    adjacency.get(left)?.add(right);
    adjacency.get(right)?.add(left);
  }
  const reached = /* @__PURE__ */ new Set([vertexIds[0]]);
  const pending2 = [vertexIds[0]];
  while (pending2.length) {
    const current = pending2.pop();
    for (const next of adjacency.get(current) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        pending2.push(next);
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
    ...typeof topology.preset === "string" ? { preset: topology.preset } : {}
  };
}
function cloneAndSortDefinition(definition) {
  const clone = {
    schemaVersion: definition.schemaVersion,
    coordinateSystem: definition.coordinateSystem,
    topology: normalizeTopology(definition.topology),
    vertices: definition.vertices.map((vertex) => ({
      id: vertex.id,
      coordinate: [vertex.coordinate[0], vertex.coordinate[1]]
    })).sort((left, right) => compareStableIdentifiers(left.id, right.id)),
    faces: definition.faces.map((face) => ({
      id: face.id,
      vertices: [...face.vertices]
    })).sort((left, right) => compareStableIdentifiers(left.id, right.id)),
    seamPairs: (definition.seamPairs ?? []).map((pair) => ({
      id: pair.id,
      edgeOccurrenceA: pair.edgeOccurrenceA,
      edgeOccurrenceB: pair.edgeOccurrenceB,
      endpointMap: [...pair.endpointMap]
    })).sort((left, right) => compareStableIdentifiers(left.id, right.id)),
    scoring: {
      strategy: definition.scoring?.strategy ?? "canonical-vertices-v1",
      ...isPlainObject(definition.scoring?.weights) ? { weights: Object.fromEntries(Object.entries(definition.scoring.weights).sort(([left], [right]) => compareStableIdentifiers(left, right))) } : {}
    }
  };
  if (isPlainObject(definition.startingVertices)) {
    clone.startingVertices = Object.fromEntries(Object.entries(definition.startingVertices).sort(([left], [right]) => compareStableIdentifiers(left, right)).map(([player, value]) => [player, Array.isArray(value) ? [...value].sort(compareStableIdentifiers) : value]));
  }
  if (isPlainObject(definition.generator)) {
    clone.generator = JSON.parse(stableStringify(definition.generator));
  }
  return clone;
}
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(value).sort(compareStableIdentifiers).map(
    (key3) => JSON.stringify(key3) + ":" + stableStringify(value[key3])
  ).join(",") + "}";
}
function rightRotate(value, bits) {
  return value >>> bits | value << 32 - bits;
}
function sha256Hex(message) {
  const bytes = new TextEncoder().encode(String(message));
  const bitLength = bytes.length * 8;
  const paddedLength = bytes.length + 9 + 63 >> 6 << 6;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 128;
  const lengthHigh = Math.floor(bitLength / 4294967296);
  const lengthLow = bitLength >>> 0;
  data[paddedLength - 8] = lengthHigh >>> 24 & 255;
  data[paddedLength - 7] = lengthHigh >>> 16 & 255;
  data[paddedLength - 6] = lengthHigh >>> 8 & 255;
  data[paddedLength - 5] = lengthHigh & 255;
  data[paddedLength - 4] = lengthLow >>> 24 & 255;
  data[paddedLength - 3] = lengthLow >>> 16 & 255;
  data[paddedLength - 2] = lengthLow >>> 8 & 255;
  data[paddedLength - 1] = lengthLow & 255;
  const constants = [
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ];
  let h0 = 1779033703;
  let h1 = 3144134277;
  let h2 = 1013904242;
  let h3 = 2773480762;
  let h4 = 1359893119;
  let h5 = 2600822924;
  let h6 = 528734635;
  let h7 = 1541459225;
  const words = new Uint32Array(64);
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      words[index] = data[start] << 24 | data[start + 1] << 16 | data[start + 2] << 8 | data[start + 3];
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rightRotate(words[index - 15], 7) ^ rightRotate(words[index - 15], 18) ^ words[index - 15] >>> 3;
      const s1 = rightRotate(words[index - 2], 17) ^ rightRotate(words[index - 2], 19) ^ words[index - 2] >>> 10;
      words[index] = words[index - 16] + s0 + words[index - 7] + s1 >>> 0;
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
      const choice = e & f ^ ~e & g;
      const temp1 = h + s1 + choice + constants[index] + words[index] >>> 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const majority = a & b ^ a & c ^ b & c;
      const temp2 = s0 + majority >>> 0;
      h = g;
      g = f;
      f = e;
      e = d + temp1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2 >>> 0;
    }
    h0 = h0 + a >>> 0;
    h1 = h1 + b >>> 0;
    h2 = h2 + c >>> 0;
    h3 = h3 + d >>> 0;
    h4 = h4 + e >>> 0;
    h5 = h5 + f >>> 0;
    h6 = h6 + g >>> 0;
    h7 = h7 + h >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((word) => word.toString(16).padStart(8, "0")).join("");
}
function validateBoardDefinition(raw, limits = {}) {
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
    addError(
      errors,
      "UNSUPPORTED_COORDINATE_SYSTEM",
      "coordinateSystem",
      "Expected triangular-axial-v1."
    );
  }
  if (!isPlainObject(raw.topology) || !VALID_TOPOLOGY_FAMILIES.has(raw.topology.family)) {
    addError(errors, "INVALID_TOPOLOGY", "topology.family", "Expected planar or surface.");
  }
  if (isPlainObject(raw.topology) && raw.topology.movementStrategy != null && !["simple-rays-v1", "simple-rays-v2", "simple-rays-v3"].includes(raw.topology.movementStrategy)) {
    addError(errors, "UNSUPPORTED_MOVEMENT_STRATEGY", "topology.movementStrategy", "Expected simple-rays-v1, simple-rays-v2 or simple-rays-v3.");
  }
  if (!Array.isArray(raw.vertices) || raw.vertices.length === 0) {
    addError(errors, "INVALID_VERTICES", "vertices", "At least one vertex is required.");
  } else if (raw.vertices.length > resolvedLimits.maxVertices) {
    addError(errors, "LIMIT_EXCEEDED", "vertices", "Too many vertices.");
  }
  const verticesById = /* @__PURE__ */ new Map();
  const coordinateIds = /* @__PURE__ */ new Map();
  if (Array.isArray(raw.vertices)) {
    raw.vertices.forEach((vertex, index) => {
      const location = "vertices[" + index + "]";
      if (!isPlainObject(vertex) || !isProtocolIdentifier(vertex.id)) {
        addError(
          errors,
          "INVALID_VERTEX_ID",
          location + ".id",
          "Vertex id must use the board-topology ASCII identifier grammar."
        );
        return;
      }
      if (verticesById.has(vertex.id)) {
        addError(errors, "DUPLICATE_VERTEX_ID", location + ".id", vertex.id);
        return;
      }
      if (!Array.isArray(vertex.coordinate) || vertex.coordinate.length !== 2 || !vertex.coordinate.every(Number.isInteger) || vertex.coordinate.some((value2) => Math.abs(value2) > resolvedLimits.coordinateAbs)) {
        addError(
          errors,
          "INVALID_COORDINATE",
          location + ".coordinate",
          "Coordinate must be two bounded integers."
        );
        return;
      }
      const key3 = vertex.coordinate.join(",");
      if (coordinateIds.has(key3)) {
        addError(errors, "DUPLICATE_VERTEX_COORDINATE", location + ".coordinate", key3);
        return;
      }
      verticesById.set(vertex.id, { id: vertex.id, coordinate: [...vertex.coordinate] });
      coordinateIds.set(key3, vertex.id);
    });
  }
  if (!Array.isArray(raw.faces) || raw.faces.length === 0) {
    addError(errors, "INVALID_FACES", "faces", "At least one triangular face is required.");
  } else if (raw.faces.length > resolvedLimits.maxFaces) {
    addError(errors, "LIMIT_EXCEEDED", "faces", "Too many faces.");
  }
  const faces = [];
  const faceIds = /* @__PURE__ */ new Set();
  const seenFaceVertexSets = /* @__PURE__ */ new Set();
  if (Array.isArray(raw.faces)) {
    raw.faces.forEach((face, index) => {
      const location = "faces[" + index + "]";
      if (!isPlainObject(face) || !isProtocolIdentifier(face.id)) {
        addError(
          errors,
          "INVALID_FACE_ID",
          location + ".id",
          "Face id must use the board-topology ASCII identifier grammar."
        );
        return;
      }
      if (faceIds.has(face.id)) {
        addError(errors, "DUPLICATE_FACE_ID", location + ".id", face.id);
        return;
      }
      faceIds.add(face.id);
      if (!Array.isArray(face.vertices) || face.vertices.length !== 3 || !face.vertices.every((id) => typeof id === "string")) {
        addError(
          errors,
          "INVALID_FACE_VERTICES",
          location + ".vertices",
          "Faces must have exactly three vertex ids."
        );
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
          addError(
            errors,
            "NON_UNIT_TRIANGULAR_EDGE",
            location + ".vertices[" + sideIndex + "]",
            stored.vertices[sideIndex] + "->" + stored.vertices[(sideIndex + 1) % stored.vertices.length]
          );
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
  for (const [rawEdgeKey3, group] of byRawEdge) {
    if (group.length > 2) {
      addError(
        errors,
        "NON_MANIFOLD_EDGE",
        "edge:" + rawEdgeKey3,
        "A raw edge has " + group.length + " face occurrences."
      );
    }
  }
  const seamPairs = [];
  const seamIds = /* @__PURE__ */ new Set();
  const pairedOccurrences = /* @__PURE__ */ new Set();
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
        addError(
          errors,
          "INVALID_SEAM_ID",
          location + ".id",
          "Seam id must use the board-topology ASCII identifier grammar."
        );
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
        addError(
          errors,
          "UNKNOWN_EDGE_OCCURRENCE",
          location,
          String(pair.edgeOccurrenceA) + "," + String(pair.edgeOccurrenceB)
        );
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
      if ((byRawEdge.get(left.rawEdgeKey) ?? []).length !== 1 || (byRawEdge.get(right.rawEdgeKey) ?? []).length !== 1) {
        addError(
          errors,
          "SEAM_REQUIRES_BOUNDARY_EDGE",
          location,
          "Only raw boundary edge occurrences can be paired."
        );
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
        endpointMap: [...pair.endpointMap]
      });
    });
  }
  let startingVertices = void 0;
  if (raw.startingVertices != null) {
    if (!isPlainObject(raw.startingVertices)) {
      addError(errors, "INVALID_STARTING_VERTICES", "startingVertices", "Expected a player-to-vertex object.");
    } else {
      const entries = Object.entries(raw.startingVertices);
      if (entries.length > resolvedLimits.maxStarts) {
        addError(errors, "LIMIT_EXCEEDED", "startingVertices", "Too many starting vertices.");
      }
      const starts = /* @__PURE__ */ new Set();
      startingVertices = {};
      for (const [player, rawValue] of entries) {
        if (!isProtocolIdentifier(player)) {
          addError(errors, "INVALID_STARTING_PLAYER_ID", "startingVertices." + player, "Invalid player id.");
          continue;
        }
        const values = Array.isArray(rawValue) ? rawValue : [rawValue];
        if (!values.length || values.length > resolvedLimits.maxStarts) {
          addError(errors, "INVALID_STARTING_VERTICES", "startingVertices." + player, "Expected one to six vertices.");
          continue;
        }
        let valid = true;
        for (const vertexId of values) {
          if (typeof vertexId !== "string" || !verticesById.has(vertexId)) {
            addError(errors, "UNKNOWN_START_VERTEX", "startingVertices." + player, String(vertexId));
            valid = false;
          } else if (starts.has(vertexId)) {
            addError(errors, "DUPLICATE_START_VERTEX", "startingVertices." + player, vertexId);
            valid = false;
          } else starts.add(vertexId);
        }
        if (valid) startingVertices[player] = Array.isArray(rawValue) ? [...values] : values[0];
      }
    }
  }
  let scoring = { strategy: "canonical-vertices-v1" };
  if (raw.scoring != null) {
    if (!isPlainObject(raw.scoring) || raw.scoring.strategy != null && raw.scoring.strategy !== "canonical-vertices-v1") {
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
    addError(
      errors,
      "INVALID_GENERATOR_KEY",
      "generator",
      "Generator object keys must use the board-topology ASCII identifier grammar."
    );
  }
  const value = {
    schemaVersion: BOARD_DEFINITION_SCHEMA_VERSION,
    coordinateSystem: "triangular-axial-v1",
    topology: normalizeTopology(isPlainObject(raw.topology) ? raw.topology : { family: "planar" }),
    vertices: [...verticesById.values()],
    faces,
    seamPairs,
    ...startingVertices ? { startingVertices } : {},
    scoring,
    ...isPlainObject(raw.generator) ? { generator: JSON.parse(stableStringify(raw.generator)) } : {}
  };
  return errors.length ? { ok: false, errors, limits: resolvedLimits } : { ok: true, value, errors: [], limits: resolvedLimits };
}
function canonicalizeBoard(definition, limits = {}) {
  const validation = validateBoardDefinition(definition, limits);
  if (!validation.ok) return validation;
  const canonicalDefinition = cloneAndSortDefinition(validation.value);
  const payload = {
    hashSchemaVersion: BOARD_HASH_SCHEMA_VERSION,
    definition: canonicalDefinition
  };
  return {
    ok: true,
    definition: canonicalDefinition,
    boardHash: sha256Hex(stableStringify(payload)),
    errors: [],
    limits: validation.limits
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
function createLegacyBoardDefinition({
  gridSize = 5,
  boardShape = "triangle"
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
  const addFace = /* @__PURE__ */ __name((id, coordinates) => {
    if (coordinates.every((point) => isLegacyPoint(point, gridSize, boardShape))) {
      faces.push({ id, vertices: coordinates.map(([x, y]) => legacyVertexId(x, y)) });
    }
  }, "addFace");
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
      preset: "legacy-" + boardShape
    },
    vertices,
    faces,
    seamPairs: [],
    scoring: { strategy: "canonical-vertices-v1" }
  };
}
var BOARD_TOPOLOGY_CONTRACT_VERSION, PROTOCOL_IDENTIFIER, BOARD_DEFINITION_SCHEMA_VERSION, BOARD_HASH_SCHEMA_VERSION, TRIANGULAR_UNIT_DIRECTIONS, DEFAULT_BOARD_LIMITS, VALID_ENDPOINT_MAPS, VALID_TOPOLOGY_FAMILIES, isPlainObject, own;
var init_BoardDefinition = __esm({
  "application-hard:BoardDefinition.js"() {
    BOARD_TOPOLOGY_CONTRACT_VERSION = "board-topology-v1";
    PROTOCOL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:,_-]{0,127}$/;
    __name(compareStableIdentifiers, "compareStableIdentifiers");
    __name(isProtocolIdentifier, "isProtocolIdentifier");
    __name(hasProtocolSafeObjectKeys, "hasProtocolSafeObjectKeys");
    BOARD_DEFINITION_SCHEMA_VERSION = 1;
    BOARD_HASH_SCHEMA_VERSION = "board-hash-v1";
    TRIANGULAR_UNIT_DIRECTIONS = Object.freeze([
      [1, 0],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [0, -1],
      [1, -1]
    ]);
    DEFAULT_BOARD_LIMITS = Object.freeze({
      maxBytes: 1024 * 1024,
      maxVertices: 1024,
      maxFaces: 2048,
      maxEdgeOccurrences: 4096,
      maxSeamPairs: 512,
      maxStarts: 6,
      maxSamples: 4096,
      coordinateAbs: 32768
    });
    VALID_ENDPOINT_MAPS = /* @__PURE__ */ new Set(["0,1", "1,0"]);
    VALID_TOPOLOGY_FAMILIES = /* @__PURE__ */ new Set(["planar", "surface"]);
    isPlainObject = /* @__PURE__ */ __name((value) => value != null && typeof value === "object" && !Array.isArray(value), "isPlainObject");
    own = /* @__PURE__ */ __name((object, key3) => Object.prototype.hasOwnProperty.call(object, key3), "own");
    __name(edgeOccurrenceId, "edgeOccurrenceId");
    __name(splitEdgeOccurrenceId, "splitEdgeOccurrenceId");
    __name(undirectedKey, "undirectedKey");
    __name(triangularDirectionIndex, "triangularDirectionIndex");
    __name(makeBoardError, "makeBoardError");
    __name(addError, "addError");
    __name(mergeLimits, "mergeLimits");
    __name(getJsonByteLength, "getJsonByteLength");
    __name(signedFaceArea, "signedFaceArea");
    __name(buildOccurrences, "buildOccurrences");
    __name(findDisconnectedVertexIds, "findDisconnectedVertexIds");
    __name(normalizeTopology, "normalizeTopology");
    __name(cloneAndSortDefinition, "cloneAndSortDefinition");
    __name(stableStringify, "stableStringify");
    __name(rightRotate, "rightRotate");
    __name(sha256Hex, "sha256Hex");
    __name(validateBoardDefinition, "validateBoardDefinition");
    __name(canonicalizeBoard, "canonicalizeBoard");
    __name(isLegacyPoint, "isLegacyPoint");
    __name(legacyVertexId, "legacyVertexId");
    __name(createLegacyBoardDefinition, "createLegacyBoardDefinition");
  }
});

// application-hard:BoardTopology.js
function rawEdgeKey(left, right) {
  return undirectedKey(left, right);
}
function makeOccurrences(definition) {
  const byId = /* @__PURE__ */ new Map();
  const byRawEdge = /* @__PURE__ */ new Map();
  for (const face of definition.faces) {
    for (let sideIndex = 0; sideIndex < face.vertices.length; sideIndex += 1) {
      const occurrence = {
        id: edgeOccurrenceId(face.id, sideIndex),
        faceId: face.id,
        sideIndex,
        vertices: [face.vertices[sideIndex], face.vertices[(sideIndex + 1) % face.vertices.length]]
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
  const groups = /* @__PURE__ */ new Map();
  for (const vertex of vertices) {
    const root = vertexUnion.find(vertex.id);
    const group = groups.get(root) ?? [];
    group.push(vertex.id);
    groups.set(root, group);
  }
  const orderedGroups = [...groups.values()].map((ids) => ids.sort(compareStableIdentifiers)).sort((left, right) => compareStableIdentifiers(left[0], right[0]));
  const rawToCanonical = /* @__PURE__ */ new Map();
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
  const signedSide = (right[0] - left[0]) * (interior[1] - left[1]) - (right[1] - left[1]) * (interior[0] - left[0]);
  const endpointInteriorDirections = [
    directionIndex(coordinatesById, leftVertexId, interiorVertexId),
    directionIndex(coordinatesById, rightVertexId, interiorVertexId)
  ];
  return {
    faceId: occurrence.faceId,
    edgeOccurrenceId: occurrence.id,
    orientedVertices: [...occurrence.vertices],
    interiorVertexId,
    faceSide: signedSide > 0 ? "left" : signedSide < 0 ? "right" : "degenerate",
    endpointInteriorDirections,
    endpointExitDirections: endpointInteriorDirections.map(oppositeDirection)
  };
}
function createDirectionTransition(source, target, endpointMap, coordinatesById, facesById) {
  const sourceFaceSide = faceSideForOccurrence(source, facesById, coordinatesById);
  const targetFaceSide = faceSideForOccurrence(target, facesById, coordinatesById);
  const endpointTransport = endpointMap.map((targetEndpointIndex, sourceEndpointIndex) => ({
    sourceEndpointIndex,
    targetEndpointIndex,
    sourceExitDirectionIndex: sourceFaceSide.endpointExitDirections[sourceEndpointIndex],
    targetEntryDirectionIndex: targetFaceSide.endpointInteriorDirections[targetEndpointIndex]
  }));
  return {
    fromEdgeOccurrenceId: source.id,
    toEdgeOccurrenceId: target.id,
    endpointMap: [...endpointMap],
    transportKind: "endpoint-face-side-v1",
    sourceFaceSide,
    targetFaceSide,
    endpointTransport
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
  const adjacency = /* @__PURE__ */ new Map();
  for (const edgeClass of edgeClasses) {
    if (edgeClass.occurrences.length !== 2) continue;
    const [left, right] = edgeClass.occurrences;
    const sameDirection = left.canonicalVertices[0] === right.canonicalVertices[0] && left.canonicalVertices[1] === right.canonicalVertices[1];
    const factor = sameDirection ? -1 : 1;
    const leftEdges = adjacency.get(left.faceId) ?? [];
    leftEdges.push({ faceId: right.faceId, factor });
    adjacency.set(left.faceId, leftEdges);
    const rightEdges = adjacency.get(right.faceId) ?? [];
    rightEdges.push({ faceId: left.faceId, factor });
    adjacency.set(right.faceId, rightEdges);
  }
  const orientation = /* @__PURE__ */ new Map();
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
  const links = new Map(canonicalVertices.map((vertex) => [vertex.id, /* @__PURE__ */ new Map()]));
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
    const kind = components.length !== 1 ? "disconnected" : !legalDegrees ? "branched" : oneDegreeCount === 0 ? "cycle" : oneDegreeCount === 2 ? "path" : "branched";
    results.push({
      id: vertex.id,
      manifold: kind === "cycle" || kind === "path",
      kind,
      incidentEdgeClassCount: nodes.length,
      components: components.length
    });
  }
  return results;
}
function analyzeBoardTopology(definition) {
  const errors = [];
  const vertexIds = definition.vertices.map((vertex) => vertex.id);
  const coordinatesById = new Map(definition.vertices.map((vertex) => [vertex.id, vertex.coordinate]));
  const facesById = new Map(definition.faces.map((face) => [face.id, face]));
  const { byId: occurrenceById, byRawEdge } = makeOccurrences(definition);
  const vertexUnion = new UnionFind(vertexIds);
  const seamPairsByOccurrence = /* @__PURE__ */ new Map();
  for (const pair of definition.seamPairs ?? []) {
    const left = occurrenceById.get(pair.edgeOccurrenceA);
    const right = occurrenceById.get(pair.edgeOccurrenceB);
    if (!left || !right) {
      errors.push(makeBoardError(
        "UNKNOWN_EDGE_OCCURRENCE",
        "seamPairs." + pair.id,
        "Pair references an occurrence that is absent from the face set."
      ));
      continue;
    }
    vertexUnion.union(left.vertices[0], right.vertices[pair.endpointMap[0]]);
    vertexUnion.union(left.vertices[1], right.vertices[pair.endpointMap[1]]);
    seamPairsByOccurrence.set(left.id, { pair, other: right, endpointMap: pair.endpointMap });
    seamPairsByOccurrence.set(right.id, {
      pair,
      other: left,
      endpointMap: endpointMapInverse(pair.endpointMap)
    });
  }
  const { rawToCanonical, canonicalVertices } = canonicalVertexGroups(vertexUnion, definition.vertices);
  const occurrenceUnion = makeOccurrenceUnion(byRawEdge, definition);
  const edgeClassGroups = /* @__PURE__ */ new Map();
  for (const occurrence of occurrenceById.values()) {
    const root = occurrenceUnion.find(occurrence.id);
    const group = edgeClassGroups.get(root) ?? [];
    group.push(occurrence);
    edgeClassGroups.set(root, group);
  }
  const edgeClassByOccurrence = /* @__PURE__ */ new Map();
  const edgeClasses = [...edgeClassGroups.values()].map((occurrences) => occurrences.sort((left, right) => compareStableIdentifiers(left.id, right.id))).sort((left, right) => compareStableIdentifiers(left[0].id, right[0].id)).map((occurrences, index) => {
    const id = "ce:" + index;
    const mapped = occurrences.map((occurrence) => ({
      ...occurrence,
      canonicalVertices: occurrence.vertices.map((vertexId) => rawToCanonical.get(vertexId))
    }));
    for (const occurrence of mapped) edgeClassByOccurrence.set(occurrence.id, id);
    return { id, occurrences: mapped };
  });
  const canonicalAdjacency = new Map(canonicalVertices.map((vertex) => [vertex.id, /* @__PURE__ */ new Set()]));
  for (const edgeClass of edgeClasses) {
    const [left, right] = edgeClass.occurrences[0].canonicalVertices;
    edgeClass.canonicalVertices = [left, right];
    if (left === right) {
      errors.push(makeBoardError(
        "DEGENERATE_QUOTIENT_EDGE",
        "edgeClasses." + edgeClass.id,
        "A glued edge has identical canonical endpoints."
      ));
      continue;
    }
    canonicalAdjacency.get(left).add(right);
    canonicalAdjacency.get(right).add(left);
  }
  const realBoundaryEdgeClassIds = edgeClasses.filter((edgeClass) => edgeClass.occurrences.length === 1).map((edgeClass) => edgeClass.id);
  const realBoundaryVertexIds = /* @__PURE__ */ new Set();
  for (const edgeClass of edgeClasses) {
    if (edgeClass.occurrences.length !== 1) continue;
    edgeClass.canonicalVertices.forEach((vertexId) => realBoundaryVertexIds.add(vertexId));
  }
  const boundaryAdjacency = new Map([...realBoundaryVertexIds].map((id) => [id, /* @__PURE__ */ new Set()]));
  for (const edgeClass of edgeClasses) {
    if (edgeClass.occurrences.length !== 1 || edgeClass.canonicalVertices[0] === edgeClass.canonicalVertices[1]) continue;
    const [left, right] = edgeClass.canonicalVertices;
    boundaryAdjacency.get(left).add(right);
    boundaryAdjacency.get(right).add(left);
  }
  const boundaryComponents = connectedComponents([...realBoundaryVertexIds], boundaryAdjacency);
  const vertexLinks = analyzeVertexLinks(canonicalVertices, definition.faces, edgeClassByOccurrence, rawToCanonical);
  const specialVertices = vertexLinks.filter((link) => !link.manifold || link.kind !== "cycle" || link.incidentEdgeClassCount !== 6).map((link) => ({ ...link, stopOnAmbiguousContinuation: true }));
  const directionTransitions = [];
  const seenTransitions = /* @__PURE__ */ new Set();
  for (const [occurrenceId, seam] of seamPairsByOccurrence) {
    const key3 = occurrenceId + ">" + seam.other.id;
    if (!seenTransitions.has(key3)) {
      seenTransitions.add(key3);
      directionTransitions.push(createDirectionTransition(
        occurrenceById.get(occurrenceId),
        seam.other,
        seam.endpointMap,
        coordinatesById,
        facesById
      ));
    }
  }
  const orientable = analyzeOrientability(edgeClasses);
  const eulerCharacteristic = canonicalVertices.length - edgeClasses.length + definition.faces.length;
  const occurrenceRecords = [...occurrenceById.values()].map((occurrence) => ({
    ...occurrence,
    canonicalVertices: occurrence.vertices.map((vertexId) => rawToCanonical.get(vertexId)),
    edgeClassId: edgeClassByOccurrence.get(occurrence.id),
    ...seamPairsByOccurrence.has(occurrence.id) ? { seamPairId: seamPairsByOccurrence.get(occurrence.id).pair.id } : {}
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
    directionTransitions
  };
}
function transportExitIntoTargetFace(transition, sourceEndpointIndex, sourceDirectionIndex) {
  const rule = transition?.endpointTransport?.find(
    (entry) => entry.sourceEndpointIndex === sourceEndpointIndex && entry.sourceExitDirectionIndex === sourceDirectionIndex
  );
  return rule ? {
    targetEndpointIndex: rule.targetEndpointIndex,
    directionState: rule.targetEntryDirectionIndex
  } : null;
}
function directionTransitionTargetsTargetFaceInterior(transition) {
  if (!transition || transition.transportKind !== "endpoint-face-side-v1" || !transition.sourceFaceSide || !transition.targetFaceSide || !Array.isArray(transition.endpointTransport)) return false;
  return transition.endpointTransport.every(
    (rule) => rule.sourceExitDirectionIndex === oppositeDirection(
      transition.sourceFaceSide.endpointInteriorDirections[rule.sourceEndpointIndex]
    ) && rule.targetEntryDirectionIndex === transition.targetFaceSide.endpointInteriorDirections[rule.targetEndpointIndex]
  );
}
function directionTransitionIsInverse(forward2, backward) {
  if (!directionTransitionTargetsTargetFaceInterior(forward2) || !directionTransitionTargetsTargetFaceInterior(backward)) return false;
  if (forward2.toEdgeOccurrenceId !== backward.fromEdgeOccurrenceId || forward2.fromEdgeOccurrenceId !== backward.toEdgeOccurrenceId) return false;
  return forward2.endpointTransport.every((rule) => {
    const inverse = backward.endpointTransport.find(
      (candidate) => candidate.sourceEndpointIndex === rule.targetEndpointIndex && candidate.targetEndpointIndex === rule.sourceEndpointIndex
    );
    return inverse != null && rule.sourceExitDirectionIndex === oppositeDirection(inverse.targetEntryDirectionIndex) && rule.targetEntryDirectionIndex === oppositeDirection(inverse.sourceExitDirectionIndex);
  });
}
function occurrenceExists(definition, occurrenceId) {
  const parsed = splitEdgeOccurrenceId(occurrenceId);
  return parsed != null && definition.faces.some(
    (face) => face.id === parsed.faceId && parsed.sideIndex < face.vertices.length
  );
}
var UnionFind, TRIANGULAR_DIRECTION_VECTORS;
var init_BoardTopology = __esm({
  "application-hard:BoardTopology.js"() {
    init_BoardDefinition();
    UnionFind = class {
      static {
        __name(this, "UnionFind");
      }
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
        if (leftRank < rightRank || leftRank === rightRank && String(leftRoot) > String(rightRoot)) {
          [leftRoot, rightRoot] = [rightRoot, leftRoot];
        }
        this.parent.set(rightRoot, leftRoot);
        if (leftRank === rightRank) this.rank.set(leftRoot, leftRank + 1);
        return leftRoot;
      }
    };
    __name(rawEdgeKey, "rawEdgeKey");
    __name(makeOccurrences, "makeOccurrences");
    __name(makeOccurrenceUnion, "makeOccurrenceUnion");
    __name(canonicalVertexGroups, "canonicalVertexGroups");
    __name(directionIndex, "directionIndex");
    __name(endpointMapInverse, "endpointMapInverse");
    __name(oppositeDirection, "oppositeDirection");
    __name(faceSideForOccurrence, "faceSideForOccurrence");
    __name(createDirectionTransition, "createDirectionTransition");
    __name(connectedComponents, "connectedComponents");
    __name(analyzeOrientability, "analyzeOrientability");
    __name(analyzeVertexLinks, "analyzeVertexLinks");
    __name(analyzeBoardTopology, "analyzeBoardTopology");
    TRIANGULAR_DIRECTION_VECTORS = TRIANGULAR_UNIT_DIRECTIONS;
    __name(transportExitIntoTargetFace, "transportExitIntoTargetFace");
    __name(directionTransitionTargetsTargetFaceInterior, "directionTransitionTargetsTargetFaceInterior");
    __name(directionTransitionIsInverse, "directionTransitionIsInverse");
    __name(occurrenceExists, "occurrenceExists");
  }
});

// application-hard:BoardCompiler.js
function deepFreeze(value, seen = /* @__PURE__ */ new Set()) {
  if (value == null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
function mapAdjacencyToObject(adjacency) {
  return Object.fromEntries([...adjacency.entries()].sort(([left], [right]) => compareStableIdentifiers(left, right)).map(([vertexId, neighbors]) => [vertexId, [...neighbors].sort()]));
}
function canonicalStartingVertices(definition, rawToCanonical) {
  const errors = [];
  const result = {};
  const occupied = /* @__PURE__ */ new Set();
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
    const sourceWeights = canonicalVertex.sourceVertexIds.map((rawVertexId) => rawWeights[rawVertexId] ?? 1);
    if (new Set(sourceWeights).size > 1) {
      errors.push(makeBoardError(
        "CONFLICTING_CANONICAL_WEIGHT",
        "scoring.weights." + canonicalVertex.id,
        canonicalVertex.sourceVertexIds.join(",")
      ));
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
    atlasCoordinates: vertex.sourceVertexIds.map((sourceVertexId) => [...coordinatesById.get(sourceVertexId)])
  }));
}
function buildCompiledBoard(definition, boardHash, topology) {
  const starts = canonicalStartingVertices(definition, topology.rawToCanonical);
  const weights = sampleWeights(definition, topology.canonicalVertices);
  const errors = [...topology.errors, ...starts.errors, ...weights.errors];
  if (errors.length) return { ok: false, errors };
  const canonicalVertices = renderCanonicalVertices(definition, topology);
  const rawVertexToCanonical = Object.fromEntries([...topology.rawToCanonical.entries()].sort(([left], [right]) => compareStableIdentifiers(left, right)));
  const sampleAdjacency = mapAdjacencyToObject(topology.canonicalAdjacency);
  const samples = canonicalVertices.map((vertex) => ({
    id: vertex.id,
    weight: weights.value[vertex.id]
  }));
  const compiled = {
    contractVersion: BOARD_TOPOLOGY_CONTRACT_VERSION,
    schemaVersion: definition.schemaVersion,
    rules: {
      movementStrategy: definition.topology.movementStrategy,
      territoryStrategy: definition.topology.territoryStrategy,
      specialVertexPolicy: definition.topology.specialVertexPolicy
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
        canonicalVertices: [...occurrence.canonicalVertices]
      }))
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
      directionMap: transition.directionMap ? [...transition.directionMap] : null
    })),
    atlas: {
      pointCopies: canonicalVertices.flatMap((vertex) => vertex.atlasCoordinates.map((coordinate, index) => ({
        canonicalVertexId: vertex.id,
        sourceVertexId: vertex.sourceVertexIds[index],
        coordinate: [...coordinate]
      })))
    }
  };
  return { ok: true, value: deepFreeze(compiled), errors: [] };
}
function compileBoard(definition, limits = {}) {
  const canonicalized = canonicalizeBoard(definition, limits);
  if (!canonicalized.ok) return canonicalized;
  return buildCompiledBoard(
    canonicalized.definition,
    canonicalized.boardHash,
    analyzeBoardTopology(canonicalized.definition)
  );
}
function compileBoardOrThrow(definition, limits = {}) {
  const result = compileBoard(definition, limits);
  if (result.ok) return result.value;
  const summary = result.errors.map((error) => error.code + "@" + error.location).join(", ");
  throw new Error("Board compilation failed: " + summary);
}
function compileLegacyBoard(options = {}) {
  return compileBoard(createLegacyBoardDefinition(options));
}
var init_BoardCompiler = __esm({
  "application-hard:BoardCompiler.js"() {
    init_BoardDefinition();
    init_BoardTopology();
    __name(deepFreeze, "deepFreeze");
    __name(mapAdjacencyToObject, "mapAdjacencyToObject");
    __name(canonicalStartingVertices, "canonicalStartingVertices");
    __name(sampleWeights, "sampleWeights");
    __name(renderCanonicalVertices, "renderCanonicalVertices");
    __name(buildCompiledBoard, "buildCompiledBoard");
    __name(compileBoard, "compileBoard");
    __name(compileBoardOrThrow, "compileBoardOrThrow");
    __name(compileLegacyBoard, "compileLegacyBoard");
  }
});

// application-hard:TopologyStateCodec.js
var TopologyStateCodec_exports = {};
__export(TopologyStateCodec_exports, {
  DEFAULT_TOPOLOGY_STATE_LIMITS: () => DEFAULT_TOPOLOGY_STATE_LIMITS,
  TOPOLOGY_RULE_STATE_VERSION: () => TOPOLOGY_RULE_STATE_VERSION,
  TOPOLOGY_STATE_FORMAT: () => TOPOLOGY_STATE_FORMAT,
  TOPOLOGY_STATE_SCHEMA_VERSION: () => TOPOLOGY_STATE_SCHEMA_VERSION,
  TopologyStateError: () => TopologyStateError,
  decodeTopologyState: () => decodeTopologyState,
  encodeTopologyState: () => encodeTopologyState
});
function fail(code, message) {
  throw new TopologyStateError(code, message);
}
function isPlainObject2(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function assertPlainObject(value, label) {
  if (!isPlainObject2(value)) fail("INVALID_OBJECT", label + " must be a plain JSON object.");
}
function assertOnlyKeys(value, allowed, label) {
  for (const key3 of Object.keys(value)) {
    if (!allowed.has(key3)) fail("UNEXPECTED_FIELD", label + "." + key3 + " is not supported by this state schema.");
  }
}
function assertRequiredKeys(value, keys, label) {
  for (const key3 of keys) {
    if (!Object.hasOwn(value, key3)) fail("MISSING_FIELD", label + "." + key3 + " is required.");
  }
}
function assertJsonValue(value, label, seen = /* @__PURE__ */ new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("NON_JSON_VALUE", label + " contains a non-finite number.");
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail("NON_JSON_VALUE", label + " contains a cycle.");
    seen.add(value);
    value.forEach((item, index) => assertJsonValue(item, label + "[" + index + "]", seen));
    seen.delete(value);
    return;
  }
  if (!isPlainObject2(value)) fail("NON_JSON_VALUE", label + " must contain only JSON values.");
  if (seen.has(value)) fail("NON_JSON_VALUE", label + " contains a cycle.");
  seen.add(value);
  for (const [key3, child] of Object.entries(value)) assertJsonValue(child, label + "." + key3, seen);
  seen.delete(value);
}
function cloneJson(value, label) {
  assertJsonValue(value, label);
  return JSON.parse(JSON.stringify(value));
}
function stateByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
function mergeLimits2(limits = {}) {
  const merged = { ...DEFAULT_TOPOLOGY_STATE_LIMITS };
  if (isPlainObject2(limits)) {
    for (const key3 of Object.keys(merged)) {
      if (Number.isInteger(limits[key3]) && limits[key3] > 0) merged[key3] = limits[key3];
    }
  }
  return merged;
}
function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => compareStableIdentifiers(left, right)));
}
function assertIdentifier(value, label) {
  if (typeof value !== "string" || !value.length) fail("INVALID_IDENTIFIER", label + " must be a non-empty string.");
  return value;
}
function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) fail("INVALID_INTEGER", label + " must be a non-negative integer.");
  return value;
}
function assertBoundedArray(value, label, maximum) {
  if (!Array.isArray(value)) fail("INVALID_ARRAY", label + " must be an array.");
  if (value.length > maximum) fail("LIMIT_EXCEEDED", label + " exceeds its configured limit.");
  return value;
}
function compileOrThrow(definition, limits) {
  const compiled = compileBoard(definition, limits);
  if (!compiled.ok) {
    const details = compiled.errors.map((error) => error.code + "@" + error.location).join(", ");
    fail("INVALID_BOARD_DEFINITION", "The embedded board definition is invalid: " + details);
  }
  return compiled.value;
}
function canonicalBoardFromInput(board, limits) {
  assertPlainObject(board, "board");
  if (!Object.hasOwn(board, "definition") || !Object.hasOwn(board, "boardHash")) {
    fail("INVALID_COMPILED_BOARD", "board must provide definition and boardHash.");
  }
  const compiled = compileOrThrow(board.definition, limits);
  if (typeof board.boardHash !== "string" || board.boardHash !== compiled.boardHash) {
    fail("BOARD_HASH_MISMATCH", "The compiled board hash does not match its definition.");
  }
  return compiled;
}
function normalizeStrategies(value, boardRules) {
  assertPlainObject(value, "strategies");
  assertOnlyKeys(value, STRATEGY_KEYS, "strategies");
  assertRequiredKeys(value, STRATEGY_KEYS, "strategies");
  const result = {};
  for (const key3 of STRATEGY_KEYS) {
    assertIdentifier(value[key3], "strategies." + key3);
    if (value[key3] !== boardRules[key3]) {
      fail("STRATEGY_MISMATCH", "strategies." + key3 + " does not match the board definition.");
    }
    result[key3] = value[key3];
  }
  return result;
}
function canonicalStarts(value, sampleIds, maximumPlayers, label) {
  assertPlainObject(value, label);
  const entries = Object.entries(value);
  if (entries.length > maximumPlayers) fail("LIMIT_EXCEEDED", label + " exceeds maxPlayers.");
  const values = /* @__PURE__ */ new Set();
  for (const [player, raw] of entries) {
    assertIdentifier(player, label + " player");
    const roots = Array.isArray(raw) ? raw : [raw];
    if (!roots.length || roots.length > 6) fail("INVALID_START_ROOT_COUNT", label + "." + player);
    for (const vertexId of roots) {
      assertIdentifier(vertexId, label + "." + player);
      if (!sampleIds.has(vertexId)) fail("UNKNOWN_CANONICAL_VERTEX", label + "." + player + " references " + vertexId);
      if (values.has(vertexId)) fail("DUPLICATE_START_VERTEX", label + " repeats " + vertexId);
      values.add(vertexId);
    }
  }
  return sortedObject(entries);
}
function sameJson(left, right) {
  return stableStringify(left) === stableStringify(right);
}
function normalizeVertexState(value, sampleIds, limits) {
  assertPlainObject(value, "ruleState.vertexStateById");
  const entries = Object.entries(value);
  if (entries.length > limits.maxVertexStates) {
    fail("LIMIT_EXCEEDED", "ruleState.vertexStateById exceeds maxVertexStates.");
  }
  const result = {};
  for (const [vertexId, state] of entries) {
    if (!sampleIds.has(vertexId)) fail("UNKNOWN_CANONICAL_VERTEX", "ruleState.vertexStateById." + vertexId);
    assertPlainObject(state, "ruleState.vertexStateById." + vertexId);
    assertOnlyKeys(state, VERTEX_STATE_KEYS, "ruleState.vertexStateById." + vertexId);
    assertRequiredKeys(state, VERTEX_STATE_KEYS, "ruleState.vertexStateById." + vertexId);
    assertIdentifier(state.owner, "ruleState.vertexStateById." + vertexId + ".owner");
    if (typeof state.node !== "boolean" || typeof state.line !== "boolean") {
      fail("INVALID_VERTEX_STATE", "ruleState.vertexStateById." + vertexId + " needs boolean node and line flags.");
    }
    if (!state.node && !state.line) {
      fail("INVALID_VERTEX_STATE", "ruleState.vertexStateById." + vertexId + " has no node or line coverage.");
    }
    result[vertexId] = { owner: state.owner, node: state.node, line: state.line };
  }
  return sortedObject(Object.entries(result));
}
function normalizeSeamCrossing(value, label, knownOccurrences) {
  assertPlainObject(value, label);
  assertOnlyKeys(value, SEAM_CROSSING_KEYS, label);
  assertRequiredKeys(value, SEAM_CROSSING_KEYS, label);
  for (const key3 of ["fromEdgeOccurrenceId", "toEdgeOccurrenceId", "sourceVertexId", "targetVertexId"]) {
    assertIdentifier(value[key3], label + "." + key3);
  }
  if (!knownOccurrences.has(value.fromEdgeOccurrenceId) || !knownOccurrences.has(value.toEdgeOccurrenceId)) {
    fail("UNKNOWN_EDGE_OCCURRENCE", label + " references an edge occurrence outside the board.");
  }
  for (const key3 of ["sourceEndpointIndex", "targetEndpointIndex", "sourceDirectionState", "targetDirectionState"]) {
    assertNonNegativeInteger(value[key3], label + "." + key3);
  }
  return {
    fromEdgeOccurrenceId: value.fromEdgeOccurrenceId,
    toEdgeOccurrenceId: value.toEdgeOccurrenceId,
    sourceVertexId: value.sourceVertexId,
    targetVertexId: value.targetVertexId,
    sourceEndpointIndex: value.sourceEndpointIndex,
    targetEndpointIndex: value.targetEndpointIndex,
    sourceDirectionState: value.sourceDirectionState,
    targetDirectionState: value.targetDirectionState
  };
}
function normalizePath(value, index, sampleIds, knownOccurrences, limits) {
  const label = "ruleState.logicPaths[" + index + "]";
  assertPlainObject(value, label);
  assertOnlyKeys(value, PATH_KEYS, label);
  assertRequiredKeys(value, PATH_KEYS, label);
  const result = {
    pathId: assertIdentifier(value.pathId, label + ".pathId"),
    owner: assertIdentifier(value.owner, label + ".owner"),
    startVertexId: assertIdentifier(value.startVertexId, label + ".startVertexId"),
    endVertexId: assertIdentifier(value.endVertexId, label + ".endVertexId"),
    vertices: [],
    edgeOccurrences: [],
    seamCrossings: [],
    directionState: assertNonNegativeInteger(value.directionState, label + ".directionState")
  };
  for (const vertexId of [result.startVertexId, result.endVertexId]) {
    if (!sampleIds.has(vertexId)) fail("UNKNOWN_CANONICAL_VERTEX", label + " references " + vertexId);
  }
  const vertices = assertBoundedArray(value.vertices, label + ".vertices", limits.maxPathVertices);
  if (vertices.length < 2) fail("INVALID_LOGIC_PATH", label + ".vertices must include two endpoints.");
  for (const vertexId of vertices) {
    assertIdentifier(vertexId, label + ".vertices");
    if (!sampleIds.has(vertexId)) fail("UNKNOWN_CANONICAL_VERTEX", label + ".vertices references " + vertexId);
    result.vertices.push(vertexId);
  }
  if (result.vertices[0] !== result.startVertexId || result.vertices[result.vertices.length - 1] !== result.endVertexId) {
    fail("PATH_ENDPOINT_MISMATCH", label + " endpoints do not match vertices.");
  }
  const occurrences = assertBoundedArray(value.edgeOccurrences, label + ".edgeOccurrences", limits.maxPathEdgeOccurrences);
  for (const occurrenceId of occurrences) {
    assertIdentifier(occurrenceId, label + ".edgeOccurrences");
    if (!knownOccurrences.has(occurrenceId)) fail("UNKNOWN_EDGE_OCCURRENCE", label + ".edgeOccurrences references " + occurrenceId);
    result.edgeOccurrences.push(occurrenceId);
  }
  const crossings = assertBoundedArray(value.seamCrossings, label + ".seamCrossings", limits.maxSeamCrossingsPerPath);
  result.seamCrossings = crossings.map((crossing, crossingIndex) => normalizeSeamCrossing(crossing, label + ".seamCrossings[" + crossingIndex + "]", knownOccurrences));
  return result;
}
function normalizePassHistory(value, limits) {
  const entries = assertBoundedArray(value, "ruleState.passHistory", limits.maxPassHistory);
  return entries.map((entry, index) => {
    const label = "ruleState.passHistory[" + index + "]";
    assertPlainObject(entry, label);
    assertOnlyKeys(entry, PASS_ENTRY_KEYS, label);
    assertRequiredKeys(entry, PASS_ENTRY_KEYS, label);
    return {
      player: assertIdentifier(entry.player, label + ".player"),
      turn: assertNonNegativeInteger(entry.turn, label + ".turn")
    };
  });
}
function normalizeRuleState(value, compiledBoard, limits) {
  assertPlainObject(value, "ruleState");
  assertOnlyKeys(value, RULE_STATE_KEYS, "ruleState");
  assertRequiredKeys(value, RULE_STATE_KEYS, "ruleState");
  if (value.stateVersion !== TOPOLOGY_RULE_STATE_VERSION) {
    fail("UNSUPPORTED_RULE_STATE", "ruleState.stateVersion is unsupported.");
  }
  assertIdentifier(value.rulesVersion, "ruleState.rulesVersion");
  if (typeof value.currentPlayer !== "string" && value.currentPlayer !== null) {
    fail("INVALID_CURRENT_PLAYER", "ruleState.currentPlayer must be a player id or null.");
  }
  if (value.currentPlayer !== null) assertIdentifier(value.currentPlayer, "ruleState.currentPlayer");
  const sampleIds = new Set(compiledBoard.sampleIds);
  const starts = canonicalStarts(value.startingVertices, sampleIds, limits.maxPlayers, "ruleState.startingVertices");
  const expectedStarts = Object.fromEntries(Object.entries(compiledBoard.startingRoots ?? compiledBoard.startingVertices).map(([player, value2]) => {
    const roots = Array.isArray(value2) ? value2 : [value2];
    return [player, Array.isArray(compiledBoard.definition.startingVertices?.[player]) ? roots : roots[0]];
  }));
  if (!sameJson(starts, expectedStarts)) {
    fail("STARTING_VERTICES_MISMATCH", "ruleState.startingVertices does not match the embedded board.");
  }
  const vertexStateById = normalizeVertexState(value.vertexStateById, sampleIds, limits);
  const occurrenceIds = new Set((compiledBoard.edgeOccurrences ?? []).map((occurrence) => occurrence.id));
  const rawPaths = assertBoundedArray(value.logicPaths, "ruleState.logicPaths", limits.maxLogicPaths);
  const pathIds = /* @__PURE__ */ new Set();
  const logicPaths = rawPaths.map((path, index) => {
    const normalized = normalizePath(path, index, sampleIds, occurrenceIds, limits);
    if (pathIds.has(normalized.pathId)) fail("DUPLICATE_PATH_ID", "ruleState.logicPaths repeats " + normalized.pathId);
    pathIds.add(normalized.pathId);
    return normalized;
  });
  const historyHashes = assertBoundedArray(value.historyHashes, "ruleState.historyHashes", limits.maxHistoryHashes);
  const historySet = /* @__PURE__ */ new Set();
  for (const hash of historyHashes) {
    assertIdentifier(hash, "ruleState.historyHashes");
    if (historySet.has(hash)) fail("DUPLICATE_HISTORY_HASH", "ruleState.historyHashes repeats " + hash);
    historySet.add(hash);
  }
  if (value.superkoPolicy !== "enforce") {
    fail("INVALID_SUPERKO_POLICY", "ruleState.superkoPolicy must be enforce.");
  }
  const consecutivePasses = assertNonNegativeInteger(value.consecutivePasses, "ruleState.consecutivePasses");
  const passHistory = normalizePassHistory(value.passHistory, limits);
  const resignedPlayers = assertBoundedArray(value.resignedPlayers, "ruleState.resignedPlayers", limits.maxResignedPlayers);
  const resignedSet = /* @__PURE__ */ new Set();
  for (const player of resignedPlayers) {
    assertIdentifier(player, "ruleState.resignedPlayers");
    if (resignedSet.has(player)) fail("DUPLICATE_RESIGNED_PLAYER", "ruleState.resignedPlayers repeats " + player);
    resignedSet.add(player);
  }
  if (typeof value.gameOver !== "boolean") fail("INVALID_GAME_OVER", "ruleState.gameOver must be boolean.");
  if (value.terminal !== null) assertPlainObject(value.terminal, "ruleState.terminal");
  if (value.gameOver && value.terminal === null) {
    fail("MISSING_TERMINAL", "A finished game must carry a terminal summary.");
  }
  if (!value.gameOver && value.terminal !== null) {
    fail("UNEXPECTED_TERMINAL", "An unfinished game cannot carry a terminal summary.");
  }
  const terminal = value.terminal === null ? null : cloneJson(value.terminal, "ruleState.terminal");
  return {
    stateVersion: TOPOLOGY_RULE_STATE_VERSION,
    rulesVersion: value.rulesVersion,
    currentPlayer: value.currentPlayer,
    startingVertices: starts,
    vertexStateById,
    logicPaths,
    historyHashes: [...historyHashes],
    superkoPolicy: "enforce",
    consecutivePasses,
    passHistory,
    resignedPlayers: [...resignedPlayers],
    gameOver: value.gameOver,
    terminal,
    turnCount: assertNonNegativeInteger(value.turnCount, "ruleState.turnCount"),
    positionRevision: assertNonNegativeInteger(value.positionRevision, "ruleState.positionRevision")
  };
}
function stateDocumentFromCompiledBoard(compiledBoard, ruleState, limits) {
  const strategies = {
    movementStrategy: compiledBoard.rules.movementStrategy,
    territoryStrategy: compiledBoard.rules.territoryStrategy,
    specialVertexPolicy: compiledBoard.rules.specialVertexPolicy
  };
  const normalizedRuleState = normalizeRuleState(ruleState, compiledBoard, limits);
  return {
    format: TOPOLOGY_STATE_FORMAT,
    schemaVersion: TOPOLOGY_STATE_SCHEMA_VERSION,
    contractVersion: BOARD_TOPOLOGY_CONTRACT_VERSION,
    boardDefinition: cloneJson(compiledBoard.definition, "board.definition"),
    boardHash: compiledBoard.boardHash,
    strategies,
    ruleState: normalizedRuleState
  };
}
function assertDocumentEnvelope(document, limits) {
  assertPlainObject(document, "topology state");
  assertOnlyKeys(document, STATE_KEYS, "topology state");
  assertRequiredKeys(document, STATE_KEYS, "topology state");
  if (document.format !== TOPOLOGY_STATE_FORMAT) fail("UNSUPPORTED_FORMAT", "Unsupported topology state format.");
  if (document.schemaVersion !== TOPOLOGY_STATE_SCHEMA_VERSION) {
    fail("UNSUPPORTED_STATE_SCHEMA", "Unsupported topology state schema version.");
  }
  if (document.contractVersion !== BOARD_TOPOLOGY_CONTRACT_VERSION) {
    fail("UNSUPPORTED_CONTRACT", "Topology contract version is unsupported.");
  }
  if (stateByteLength(document) > limits.maxStateBytes) {
    fail("LIMIT_EXCEEDED", "Topology state exceeds maxStateBytes.");
  }
}
function parseStateInput(json) {
  if (typeof json === "string") {
    try {
      return JSON.parse(json);
    } catch {
      fail("INVALID_JSON", "Topology state text is not valid JSON.");
    }
  }
  return json;
}
function encodeTopologyState(board, ruleState, limits = {}) {
  const resolvedLimits = mergeLimits2(limits);
  const compiledBoard = canonicalBoardFromInput(board, limits);
  const document = stateDocumentFromCompiledBoard(compiledBoard, ruleState, resolvedLimits);
  if (stateByteLength(document) > resolvedLimits.maxStateBytes) {
    fail("LIMIT_EXCEEDED", "Topology state exceeds maxStateBytes.");
  }
  return cloneJson(document, "topology state");
}
function decodeTopologyState(json, limits = {}) {
  const resolvedLimits = mergeLimits2(limits);
  const input = parseStateInput(json);
  assertDocumentEnvelope(input, resolvedLimits);
  const definitionClone = cloneJson(input.boardDefinition, "boardDefinition");
  const compiledBoard = compileOrThrow(definitionClone, limits);
  if (input.boardHash !== compiledBoard.boardHash) {
    fail("BOARD_HASH_MISMATCH", "Stored boardHash does not match the embedded definition.");
  }
  if (!sameJson(input.boardDefinition, compiledBoard.definition)) {
    fail("NONCANONICAL_DEFINITION", "Stored boardDefinition is not canonical; it cannot be silently rewritten.");
  }
  const strategies = normalizeStrategies(input.strategies, compiledBoard.rules);
  const ruleState = normalizeRuleState(input.ruleState, compiledBoard, resolvedLimits);
  return {
    format: TOPOLOGY_STATE_FORMAT,
    schemaVersion: TOPOLOGY_STATE_SCHEMA_VERSION,
    contractVersion: BOARD_TOPOLOGY_CONTRACT_VERSION,
    board: compiledBoard,
    boardDefinition: cloneJson(compiledBoard.definition, "compiled definition"),
    boardHash: compiledBoard.boardHash,
    strategies,
    ruleState
  };
}
var TOPOLOGY_STATE_FORMAT, TOPOLOGY_STATE_SCHEMA_VERSION, TOPOLOGY_RULE_STATE_VERSION, DEFAULT_TOPOLOGY_STATE_LIMITS, STATE_KEYS, STRATEGY_KEYS, RULE_STATE_KEYS, VERTEX_STATE_KEYS, PATH_KEYS, SEAM_CROSSING_KEYS, PASS_ENTRY_KEYS, TopologyStateError;
var init_TopologyStateCodec = __esm({
  "application-hard:TopologyStateCodec.js"() {
    init_BoardDefinition();
    init_BoardCompiler();
    TOPOLOGY_STATE_FORMAT = "lifeline-topology-state";
    TOPOLOGY_STATE_SCHEMA_VERSION = 1;
    TOPOLOGY_RULE_STATE_VERSION = 1;
    DEFAULT_TOPOLOGY_STATE_LIMITS = Object.freeze({
      maxStateBytes: 1024 * 1024,
      maxPlayers: 6,
      maxVertexStates: 4096,
      maxLogicPaths: 4096,
      maxPathVertices: 4096,
      maxPathEdgeOccurrences: 4096,
      maxSeamCrossingsPerPath: 4096,
      maxHistoryHashes: 32768,
      maxPassHistory: 32768,
      maxResignedPlayers: 6
    });
    STATE_KEYS = /* @__PURE__ */ new Set([
      "format",
      "schemaVersion",
      "contractVersion",
      "boardDefinition",
      "boardHash",
      "strategies",
      "ruleState"
    ]);
    STRATEGY_KEYS = /* @__PURE__ */ new Set([
      "movementStrategy",
      "territoryStrategy",
      "specialVertexPolicy"
    ]);
    RULE_STATE_KEYS = /* @__PURE__ */ new Set([
      "stateVersion",
      "rulesVersion",
      "currentPlayer",
      "startingVertices",
      "vertexStateById",
      "logicPaths",
      "historyHashes",
      "superkoPolicy",
      "consecutivePasses",
      "passHistory",
      "resignedPlayers",
      "gameOver",
      "terminal",
      "turnCount",
      "positionRevision"
    ]);
    VERTEX_STATE_KEYS = /* @__PURE__ */ new Set(["owner", "node", "line"]);
    PATH_KEYS = /* @__PURE__ */ new Set([
      "pathId",
      "owner",
      "startVertexId",
      "endVertexId",
      "vertices",
      "edgeOccurrences",
      "seamCrossings",
      "directionState"
    ]);
    SEAM_CROSSING_KEYS = /* @__PURE__ */ new Set([
      "fromEdgeOccurrenceId",
      "toEdgeOccurrenceId",
      "sourceVertexId",
      "targetVertexId",
      "sourceEndpointIndex",
      "targetEndpointIndex",
      "sourceDirectionState",
      "targetDirectionState"
    ]);
    PASS_ENTRY_KEYS = /* @__PURE__ */ new Set(["player", "turn"]);
    TopologyStateError = class extends Error {
      static {
        __name(this, "TopologyStateError");
      }
      constructor(code, message) {
        super(message);
        this.name = "TopologyStateError";
        this.code = code;
      }
    };
    __name(fail, "fail");
    __name(isPlainObject2, "isPlainObject");
    __name(assertPlainObject, "assertPlainObject");
    __name(assertOnlyKeys, "assertOnlyKeys");
    __name(assertRequiredKeys, "assertRequiredKeys");
    __name(assertJsonValue, "assertJsonValue");
    __name(cloneJson, "cloneJson");
    __name(stateByteLength, "stateByteLength");
    __name(mergeLimits2, "mergeLimits");
    __name(sortedObject, "sortedObject");
    __name(assertIdentifier, "assertIdentifier");
    __name(assertNonNegativeInteger, "assertNonNegativeInteger");
    __name(assertBoundedArray, "assertBoundedArray");
    __name(compileOrThrow, "compileOrThrow");
    __name(canonicalBoardFromInput, "canonicalBoardFromInput");
    __name(normalizeStrategies, "normalizeStrategies");
    __name(canonicalStarts, "canonicalStarts");
    __name(sameJson, "sameJson");
    __name(normalizeVertexState, "normalizeVertexState");
    __name(normalizeSeamCrossing, "normalizeSeamCrossing");
    __name(normalizePath, "normalizePath");
    __name(normalizePassHistory, "normalizePassHistory");
    __name(normalizeRuleState, "normalizeRuleState");
    __name(stateDocumentFromCompiledBoard, "stateDocumentFromCompiledBoard");
    __name(assertDocumentEnvelope, "assertDocumentEnvelope");
    __name(parseStateInput, "parseStateInput");
    __name(encodeTopologyState, "encodeTopologyState");
    __name(decodeTopologyState, "decodeTopologyState");
  }
});

// application-hard:TopologyAIAdapter.js
var TopologyAIAdapter_exports = {};
__export(TopologyAIAdapter_exports, {
  TOPOLOGY_AI_ADAPTER_VERSION: () => TOPOLOGY_AI_ADAPTER_VERSION,
  TOPOLOGY_AI_PASS: () => TOPOLOGY_AI_PASS,
  TOPOLOGY_AI_ROUTE: () => TOPOLOGY_AI_ROUTE,
  TOPOLOGY_AI_STATE_VERSION: () => TOPOLOGY_AI_STATE_VERSION,
  buildTopologyAIState: () => buildTopologyAIState,
  computeTopologyDistances: () => computeTopologyDistances,
  describeTopologyAI: () => describeTopologyAI,
  rankTopologyCandidates: () => rankTopologyCandidates,
  validateTopologyAIRequest: () => validateTopologyAIRequest
});
function adapterError(code, location, detail = "") {
  return { code, location, detail };
}
function cloneJson2(value) {
  return JSON.parse(JSON.stringify(value));
}
function compiledSamples(board) {
  if (!isPlainObject3(board) || typeof board.boardHash !== "string" || !board.boardHash) {
    throw new TypeError("A compiled board with a boardHash is required.");
  }
  if (!Array.isArray(board.sampleIds) || board.sampleIds.length === 0 || board.sampleIds.some((id) => typeof id !== "string" || !id)) {
    throw new TypeError("Compiled board sampleIds must be non-empty canonical strings.");
  }
  const samples = new Set(board.sampleIds);
  if (samples.size !== board.sampleIds.length) {
    throw new TypeError("Compiled board sampleIds must be unique.");
  }
  if (!isPlainObject3(board.sampleAdjacency) && !(board.sampleAdjacency instanceof Map)) {
    throw new TypeError("Compiled board sampleAdjacency is required.");
  }
  return samples;
}
function adjacencyValues(adjacency, id) {
  return adjacency instanceof Map ? adjacency.get(id) ?? [] : adjacency[id] ?? [];
}
function graphFor(board) {
  const samples = compiledSamples(board);
  const graph = /* @__PURE__ */ new Map();
  for (const id of samples) {
    const values = adjacencyValues(board.sampleAdjacency, id);
    if (!Array.isArray(values)) throw new TypeError("sampleAdjacency." + id + " must be an array.");
    const seen = /* @__PURE__ */ new Set();
    for (const neighbor of values) {
      if (typeof neighbor !== "string" || !samples.has(neighbor)) {
        throw new TypeError("sampleAdjacency." + id + " references an unknown sample.");
      }
      if (neighbor === id || seen.has(neighbor)) {
        throw new TypeError("sampleAdjacency." + id + " is not a simple graph neighborhood.");
      }
      seen.add(neighbor);
    }
    graph.set(id, [...seen].sort());
  }
  for (const [id, neighbors] of graph) {
    for (const neighbor of neighbors) {
      if (!graph.get(neighbor).includes(id)) {
        throw new TypeError("sampleAdjacency must be symmetric: " + id + " / " + neighbor);
      }
    }
  }
  return { samples, graph };
}
function normalizeCanonicalIds(value, samples, location, { allowPass = false } = {}) {
  if (!Array.isArray(value)) throw new TypeError(location + " must be an array.");
  const result = [];
  const seen = /* @__PURE__ */ new Set();
  for (const id of value) {
    if (id === TOPOLOGY_AI_PASS && allowPass) {
      if (seen.has(id)) throw new TypeError(location + " contains duplicate PASS.");
      seen.add(id);
      result.push(id);
      continue;
    }
    if (typeof id !== "string" || !samples.has(id)) {
      throw new TypeError(location + " contains an unknown canonical vertex.");
    }
    if (seen.has(id)) throw new TypeError(location + " contains duplicate canonical vertices.");
    seen.add(id);
    result.push(id);
  }
  return result;
}
function normalizeCoverage(raw, samples) {
  if (!isPlainObject3(raw)) throw new TypeError("coverageByPlayer must be a plain object.");
  const result = {};
  const owners = /* @__PURE__ */ new Map();
  for (const playerId of Object.keys(raw).sort()) {
    if (typeof playerId !== "string" || !playerId) {
      throw new TypeError("coverageByPlayer has an invalid player identifier.");
    }
    const ids = normalizeCanonicalIds(raw[playerId], samples, "coverageByPlayer." + playerId);
    for (const id of ids) {
      const owner = owners.get(id);
      if (owner && owner !== playerId) {
        throw new TypeError("coverageByPlayer overlaps at " + id);
      }
      owners.set(id, playerId);
    }
    result[playerId] = ids.slice().sort();
  }
  return result;
}
function normalizeLogicalPaths(raw, samples) {
  if (raw == null) return {};
  if (!isPlainObject3(raw)) throw new TypeError("logicalPathsByPlayer must be a plain object.");
  const result = {};
  for (const playerId of Object.keys(raw).sort()) {
    if (!Array.isArray(raw[playerId])) throw new TypeError("logicalPathsByPlayer." + playerId + " must be an array.");
    const ids = /* @__PURE__ */ new Set();
    result[playerId] = raw[playerId].map((path, index) => {
      if (!isPlainObject3(path) || typeof path.pathId !== "string" || !path.pathId) {
        throw new TypeError("logicalPathsByPlayer." + playerId + "[" + index + "].pathId is required.");
      }
      if (ids.has(path.pathId)) throw new TypeError("logicalPathsByPlayer." + playerId + " duplicates " + path.pathId);
      ids.add(path.pathId);
      const vertices = normalizeCanonicalIds(
        path.vertices,
        samples,
        "logicalPathsByPlayer." + playerId + "[" + index + "].vertices"
      );
      if (vertices.length < 2) throw new TypeError("A logical path needs at least two vertices.");
      return { ...cloneJson2(path), vertices };
    }).sort((left, right) => compareStableIdentifiers(left.pathId, right.pathId));
  }
  return result;
}
function describeTopologyAI(board) {
  compiledSamples(board);
  const family = board.definition?.topology?.family ?? "unknown";
  return Object.freeze({
    adapterVersion: TOPOLOGY_AI_ADAPTER_VERSION,
    boardHash: board.boardHash,
    topologyFamily: family,
    route: TOPOLOGY_AI_ROUTE,
    requiresGenericGraphSearch: true,
    fixedShapeModelsAllowed: false,
    strengthVerified: false
  });
}
function computeTopologyDistances(board, sourceVertexIds, options = {}) {
  const { samples, graph } = graphFor(board);
  const sources = normalizeCanonicalIds(sourceVertexIds, samples, "sourceVertexIds");
  const blocked = new Set(normalizeCanonicalIds(options.blockedVertexIds ?? [], samples, "blockedVertexIds"));
  const distances2 = Object.fromEntries([...samples].sort().map((id) => [id, null]));
  const queue = [];
  for (const source of sources) {
    if (blocked.has(source) || distances2[source] !== null) continue;
    distances2[source] = 0;
    queue.push(source);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    for (const next of graph.get(current)) {
      if (blocked.has(next) || distances2[next] !== null) continue;
      distances2[next] = distances2[current] + 1;
      queue.push(next);
    }
  }
  return distances2;
}
function rankTopologyCandidates(board, legalMoveIds, options = {}) {
  const { samples, graph } = graphFor(board);
  const legal = normalizeCanonicalIds(legalMoveIds, samples, "legalMoveIds", { allowPass: true });
  const anchors = normalizeCanonicalIds(options.anchorVertexIds ?? [], samples, "anchorVertexIds");
  const distances2 = anchors.length ? computeTopologyDistances(board, anchors, {
    blockedVertexIds: options.blockedVertexIds ?? []
  }) : Object.fromEntries([...samples].map((id) => [id, null]));
  const candidates = legal.filter((id) => id !== TOPOLOGY_AI_PASS).map((vertexId) => ({
    vertexId,
    distance: distances2[vertexId],
    degree: graph.get(vertexId).length
  })).sort((left, right) => {
    const leftDistance = left.distance ?? Number.POSITIVE_INFINITY;
    const rightDistance = right.distance ?? Number.POSITIVE_INFINITY;
    return leftDistance - rightDistance || right.degree - left.degree || compareStableIdentifiers(left.vertexId, right.vertexId);
  });
  if (legal.includes(TOPOLOGY_AI_PASS)) {
    candidates.push({ vertexId: TOPOLOGY_AI_PASS, distance: null, degree: 0, isPass: true });
  }
  return candidates;
}
function buildTopologyAIState(board, state) {
  const samples = compiledSamples(board);
  if (!isPlainObject3(state)) throw new TypeError("state must be a plain object.");
  if (typeof state.rulesVersion !== "string" || !state.rulesVersion) {
    throw new TypeError("state.rulesVersion is required.");
  }
  if (!Number.isInteger(state.positionRevision) || state.positionRevision < 0) {
    throw new TypeError("state.positionRevision must be a non-negative integer.");
  }
  if (typeof state.currentPlayer !== "string" || !state.currentPlayer) {
    throw new TypeError("state.currentPlayer is required.");
  }
  const legalMoveIds = normalizeCanonicalIds(state.legalMoveIds ?? [], samples, "state.legalMoveIds", { allowPass: true });
  const coverageByPlayer = normalizeCoverage(state.coverageByPlayer ?? {}, samples);
  const logicalPathsByPlayer = normalizeLogicalPaths(state.logicalPathsByPlayer, samples);
  if (state.historyHashes != null && (!Array.isArray(state.historyHashes) || state.historyHashes.some((hash) => typeof hash !== "string" || !hash))) {
    throw new TypeError("state.historyHashes must be an array of non-empty strings.");
  }
  const definition = board.definition ?? null;
  if (!isPlainObject3(definition)) throw new TypeError("Compiled board definition is required.");
  return {
    contractVersion: TOPOLOGY_AI_STATE_VERSION,
    boardHash: board.boardHash,
    boardDefinition: cloneJson2(definition),
    rulesVersion: state.rulesVersion,
    positionRevision: state.positionRevision,
    currentPlayer: state.currentPlayer,
    legalMoveIds: [...legalMoveIds],
    coverageByPlayer,
    logicalPathsByPlayer,
    historyHashes: [...state.historyHashes ?? []].sort()
  };
}
function validateTopologyAIRequest(board, request, options = {}) {
  const errors = [];
  let samples;
  try {
    samples = compiledSamples(board);
  } catch (error) {
    return { ok: false, errors: [adapterError("INVALID_COMPILED_BOARD", "board", error.message)] };
  }
  if (!isPlainObject3(request)) {
    return { ok: false, errors: [adapterError("INVALID_REQUEST", "$", "Expected a plain object.")] };
  }
  if (request.contractVersion !== TOPOLOGY_AI_ADAPTER_VERSION) {
    errors.push(adapterError("UNSUPPORTED_CONTRACT", "contractVersion", TOPOLOGY_AI_ADAPTER_VERSION));
  }
  if (request.boardHash !== board.boardHash) {
    errors.push(adapterError("BOARD_HASH_MISMATCH", "boardHash", String(request.boardHash ?? "")));
  }
  if (typeof request.rulesVersion !== "string" || !request.rulesVersion) {
    errors.push(adapterError("MISSING_RULES_VERSION", "rulesVersion"));
  } else if (options.rulesVersion && request.rulesVersion !== options.rulesVersion) {
    errors.push(adapterError("RULES_VERSION_MISMATCH", "rulesVersion", request.rulesVersion));
  }
  if (!Number.isInteger(request.positionRevision) || request.positionRevision < 0) {
    errors.push(adapterError("INVALID_POSITION_REVISION", "positionRevision"));
  } else if (Number.isInteger(options.positionRevision) && request.positionRevision !== options.positionRevision) {
    errors.push(adapterError("POSITION_REVISION_MISMATCH", "positionRevision", String(request.positionRevision)));
  }
  if (typeof request.currentPlayer !== "string" || !request.currentPlayer) {
    errors.push(adapterError("MISSING_CURRENT_PLAYER", "currentPlayer"));
  } else if (options.currentPlayer && request.currentPlayer !== options.currentPlayer) {
    errors.push(adapterError("CURRENT_PLAYER_MISMATCH", "currentPlayer", request.currentPlayer));
  }
  if (request.modelRoute != null && request.modelRoute !== TOPOLOGY_AI_ROUTE) {
    errors.push(adapterError("LEGACY_FIXED_SHAPE_ROUTE", "modelRoute", String(request.modelRoute)));
  }
  let legalMoveIds = null;
  try {
    legalMoveIds = normalizeCanonicalIds(request.legalMoveIds, samples, "legalMoveIds", { allowPass: true });
  } catch (error) {
    errors.push(adapterError("INVALID_LEGAL_MOVES", "legalMoveIds", error.message));
  }
  let state = null;
  try {
    state = buildTopologyAIState(board, request.state);
  } catch (error) {
    errors.push(adapterError("INVALID_TOPOLOGY_STATE", "state", error.message));
  }
  if (state && state.boardHash !== request.boardHash) {
    errors.push(adapterError("STATE_BOARD_HASH_MISMATCH", "state.boardHash", state.boardHash));
  }
  if (state && (state.rulesVersion !== request.rulesVersion || state.positionRevision !== request.positionRevision || state.currentPlayer !== request.currentPlayer)) {
    errors.push(adapterError(
      "STATE_REQUEST_MISMATCH",
      "state",
      "rulesVersion, positionRevision and currentPlayer must match the request."
    ));
  }
  if (state && legalMoveIds && JSON.stringify(state.legalMoveIds) !== JSON.stringify(legalMoveIds)) {
    errors.push(adapterError("STATE_LEGAL_MOVES_MISMATCH", "state.legalMoveIds"));
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: { ...cloneJson2(request), legalMoveIds, state }, errors: [] };
}
var TOPOLOGY_AI_ADAPTER_VERSION, TOPOLOGY_AI_STATE_VERSION, TOPOLOGY_AI_ROUTE, TOPOLOGY_AI_PASS, isPlainObject3, own2;
var init_TopologyAIAdapter = __esm({
  "application-hard:TopologyAIAdapter.js"() {
    init_BoardDefinition();
    TOPOLOGY_AI_ADAPTER_VERSION = "topology-ai-v1";
    TOPOLOGY_AI_STATE_VERSION = "topology-ai-state-v1";
    TOPOLOGY_AI_ROUTE = "topology-generic-search-v1";
    TOPOLOGY_AI_PASS = "PASS";
    isPlainObject3 = /* @__PURE__ */ __name((value) => value != null && typeof value === "object" && !Array.isArray(value), "isPlainObject");
    own2 = /* @__PURE__ */ __name((value, key3) => Object.prototype.hasOwnProperty.call(value, key3), "own");
    __name(adapterError, "adapterError");
    __name(cloneJson2, "cloneJson");
    __name(compiledSamples, "compiledSamples");
    __name(adjacencyValues, "adjacencyValues");
    __name(graphFor, "graphFor");
    __name(normalizeCanonicalIds, "normalizeCanonicalIds");
    __name(normalizeCoverage, "normalizeCoverage");
    __name(normalizeLogicalPaths, "normalizeLogicalPaths");
    __name(describeTopologyAI, "describeTopologyAI");
    __name(computeTopologyDistances, "computeTopologyDistances");
    __name(rankTopologyCandidates, "rankTopologyCandidates");
    __name(buildTopologyAIState, "buildTopologyAIState");
    __name(validateTopologyAIRequest, "validateTopologyAIRequest");
  }
});

// application-hard:RootStability.js
function stabilityPointKey(point) {
  if (Array.isArray(point)) return `${point[0]},${point[1]}`;
  if (point && typeof point === "object") return String(point.vertexId ?? point.id);
  return String(point);
}
function explicitPaths(engine, player) {
  const topologyPaths = engine.topologyPaths?.[player];
  if (topologyPaths instanceof Map) {
    return [...topologyPaths.values()].map((path) => ({
      id: path.pathId,
      from: path.startVertexId,
      to: path.endVertexId,
      vertices: path.vertices
    }));
  }
  const paths = [];
  for (const id of engine._getEdges?.(player) ?? engine.edges?.[player] ?? []) {
    if (typeof id !== "string") continue;
    const ends = id.split("|");
    if (ends.length !== 2) continue;
    const from = ends[0].split(",").map(Number), to = ends[1].split(",").map(Number);
    if (from.length !== 2 || to.length !== 2 || ![...from, ...to].every(Number.isFinite)) continue;
    paths.push({ id, from, to, vertices: engine.getLinePoints(from, to) });
  }
  return paths;
}
function computeRootStability(engine, player = engine.currentPlayer) {
  const friendly = new Set((engine._getPlayerNodes?.(player) ?? []).map(stabilityPointKey));
  const roots = engine.initialRoots?.[player] ?? engine.compiledBoard?.startingRoots?.[player] ?? (engine.initialPositions?.[player] ? [engine.initialPositions[player]] : []);
  const rootKeys = [...new Set(roots.map(stabilityPointKey))].filter((key3) => friendly.has(key3));
  const certified = new Set(rootKeys), queue = [...rootKeys];
  const dependencies = /* @__PURE__ */ new Map(), rules = [], certifiedPaths = /* @__PURE__ */ new Set();
  for (const path of explicitPaths(engine, player)) {
    const from = stabilityPointKey(path.from), to = stabilityPointKey(path.to);
    const vertices = (path.vertices ?? []).map(stabilityPointKey);
    if (from === to || vertices.length < 2 || !friendly.has(from) || !friendly.has(to)) continue;
    if (vertices[0] !== from || vertices.at(-1) !== to) {
      if (vertices[0] !== to || vertices.at(-1) !== from) continue;
      vertices.reverse();
    }
    const interior = vertices.slice(1, -1);
    if (!interior.every((key3) => friendly.has(key3))) continue;
    for (const [source, target] of [[from, to], [to, from]]) {
      const required = /* @__PURE__ */ new Set([source, ...interior]);
      if (required.has(target)) continue;
      const rule = { target, pathId: path.id, remaining: required.size };
      rules.push(rule);
      for (const key3 of required) {
        if (!dependencies.has(key3)) dependencies.set(key3, []);
        dependencies.get(key3).push(rule);
      }
    }
  }
  for (let i = 0; i < queue.length; i += 1) {
    for (const rule of dependencies.get(queue[i]) ?? []) {
      rule.remaining -= 1;
      if (rule.remaining !== 0) continue;
      certifiedPaths.add(rule.pathId);
      if (!certified.has(rule.target)) {
        certified.add(rule.target);
        queue.push(rule.target);
      }
    }
  }
  return {
    version: ROOT_STABILITY_VERSION,
    kind: "sufficient-only",
    complete: true,
    player,
    rootKeys,
    nodeKeys: [...certified],
    nodeCount: certified.size,
    certifiedPathIds: [...certifiedPaths]
  };
}
var ROOT_STABILITY_VERSION;
var init_RootStability = __esm({
  "application-hard:RootStability.js"() {
    ROOT_STABILITY_VERSION = "root-stability-v1";
    __name(stabilityPointKey, "stabilityPointKey");
    __name(explicitPaths, "explicitPaths");
    __name(computeRootStability, "computeRootStability");
  }
});

// application-hard:EncirclementFeatures.js
function computeEncirclementFeatures(engine, owner, check2 = () => {
}) {
  const actor = engine.currentPlayer;
  if (engine.gameOver || actor === owner || engine.resignedPlayers.has(actor)) {
    return { pressure: 0, components: 0, enemyNodes: 0, legalMoves: 0, insideMoves: 0 };
  }
  const enemyNodes = new Set(engine._getPlayerNodes(actor).map(stabilityPointKey));
  let components;
  if (engine.isTopologyBoard) {
    if (engine.hasPendingTerritoryUpdate()) engine._updateTerritories();
    check2();
    const all = engine.cachedTerritories[owner]?.components ?? [];
    const closed = (engine.compiledBoard.realBoundarySampleIds ?? []).length === 0;
    const maxSize = Math.max(0, ...all.map((c) => c.sampleIds.length));
    components = all.filter((c) => !c.touchesRealBoundary && c.containsEnemy && (!closed || all.length > 1 && c.sampleIds.length < maxSize)).map((c) => new Set(c.sampleIds));
  } else {
    const positions = engine.validPositions, index = new Map(positions.map((point, i) => [stabilityPointKey(point), i]));
    const wall = new Set([...engine._getPlayerNodes(owner), ...engine._getPlayerLines(owner)].map(stabilityPointKey));
    const boundary = new Set(engine._boundaryIdxs), seen = /* @__PURE__ */ new Set(), found = [];
    for (let i = 0; i < positions.length; i++) {
      check2();
      const id = stabilityPointKey(positions[i]);
      if (wall.has(id) || seen.has(id)) continue;
      const queue = [positions[i]], part = /* @__PURE__ */ new Set([id]);
      seen.add(id);
      let touches = boundary.has(i), contains = enemyNodes.has(id);
      for (let cursor = 0; cursor < queue.length; cursor++) {
        check2();
        for (const next of engine.getAdjacentPositions(queue[cursor])) {
          const nextKey = stabilityPointKey(next);
          if (wall.has(nextKey) || seen.has(nextKey)) continue;
          seen.add(nextKey);
          part.add(nextKey);
          queue.push(next);
          touches ||= boundary.has(index.get(nextKey));
          contains ||= enemyNodes.has(nextKey);
        }
      }
      if (!touches && contains) found.push(part);
    }
    components = found;
  }
  const inside = new Set(components.flatMap((part) => [...part]));
  const enclosedNodes = [...enemyNodes].filter((id) => inside.has(id)).length;
  if (!enclosedNodes) return { pressure: 0, components: 0, enemyNodes: 0, legalMoves: 0, insideMoves: 0 };
  let legalMoves = 0, insideMoves = 0;
  for (const point of engine.validPositions) {
    check2();
    if (!engine._evaluateMove(point, actor).legal) continue;
    legalMoves++;
    if (inside.has(stabilityPointKey(point))) insideMoves++;
  }
  check2();
  const freedom = 1 + legalMoves;
  return {
    pressure: enclosedNodes * (1 + insideMoves) / (freedom * freedom),
    components: components.length,
    enemyNodes: enclosedNodes,
    legalMoves,
    insideMoves
  };
}
var init_EncirclementFeatures = __esm({
  "application-hard:EncirclementFeatures.js"() {
    init_RootStability();
    __name(computeEncirclementFeatures, "computeEncirclementFeatures");
  }
});

// application-hard:TopologySearchAI.js
var TopologySearchAI_exports = {};
__export(TopologySearchAI_exports, {
  searchTopologyMoves: () => searchTopologyMoves
});
function searchTopologyMoves(engine, options = {}) {
  if (!engine?.isTopologyBoard) throw new TypeError("Topology search requires a topology engine.");
  const aiPlayer = options.aiPlayer ?? engine.currentPlayer;
  if (engine.gameOver || engine.currentPlayer !== aiPlayer) {
    throw new Error("Topology search requires the current player in an unfinished game.");
  }
  const started = now();
  const timeLimitMs = Math.max(25, Math.min(5e3, Number(options.timeLimitMs) || 3e3));
  const deadline = Number.isFinite(options.deadline) ? options.deadline : started + timeLimitMs;
  const maxNodes = Math.max(1, Math.min(5e4, Math.floor(Number(options.maxNodes) || 5e4)));
  const maxDepth = Math.max(1, Math.min(12, Math.floor(Number(options.maxDepth) || 2)));
  const topN = Math.max(1, Math.min(10, Math.floor(Number(options.topN) || 1)));
  const stabilityWeight = Number.isFinite(options.stabilityWeight) ? options.stabilityWeight : 100;
  const original = engine._captureTopologyState();
  const originalBatch = engine._isReplayingBatch;
  const originalDefer = engine.deferTerritoryUpdates;
  const hadOwnHasValidMoves = Object.hasOwn(engine, "_hasValidMoves");
  const originalHasValidMoves = engine._hasValidMoves;
  const players = [...engine.activePlayers];
  const playerIndex = new Map(players.map((player, index) => [player, index]));
  const aiIndex = playerIndex.get(aiPlayer);
  let nodes = 0;
  let completedDepth = 0;
  let budgetExceeded = false;
  let rootCount = 0;
  let completed = [];
  let partial = [];
  let legalRoots = [];
  let firstLegalRoot = null;
  let legalEnumerationComplete = false;
  let partialIterationDiscarded = false;
  let opponentActions = 0;
  let maxOpponentActionsOnVisitedPath = 0;
  const opponentActionCounts = new Map(players.filter((player) => player !== aiPlayer && !engine.resignedPlayers.has(player)).map((player) => [player, 0]));
  let maxOpponentRoundsOnVisitedPath = 0;
  const checkBudget = /* @__PURE__ */ __name(() => {
    if (nodes >= maxNodes || now() >= deadline) throw LIMIT;
  }, "checkBudget");
  const evaluate3 = /* @__PURE__ */ __name(() => {
    checkBudget();
    if (engine.hasPendingTerritoryUpdate()) engine._updateTerritories();
    checkBudget();
    const scores = engine.getScoreboard();
    checkBudget();
    const survivors = new Set(engine._getRemainingPlayers());
    const winner = engine.gameOver ? engine.getWinner() : null;
    return players.map((player) => {
      if (!survivors.has(player)) return -1e8;
      if (winner && winner !== "DRAW") return winner === player ? 1e8 : -1e8;
      const strongestOpponent = Math.max(0, ...players.filter((other) => other !== player && survivors.has(other)).map((other) => scores[other]?.area ?? 0));
      const stableNodes = engine.gameOver || stabilityWeight === 0 ? 0 : computeRootStability(engine, player).nodeCount;
      checkBudget();
      const pressure = engine.gameOver ? 0 : computeEncirclementFeatures(engine, player, checkBudget).pressure;
      return 1e3 * ((scores[player]?.area ?? 0) - strongestOpponent) + stabilityWeight * stableNodes + 50 * pressure + (engine.gameOver ? 0 : engine._getPlayerNodes(player).length);
    });
  }, "evaluate");
  const orderedActions = /* @__PURE__ */ __name(() => {
    const actor = engine.currentPlayer;
    const legal = [];
    for (const vertexId of engine.validPositions) {
      checkBudget();
      const result = engine._evaluateMove(vertexId, actor);
      if (result.legal) {
        legal.push({ vertexId, isAttack: result.isAttack });
        if (actor === aiPlayer && firstLegalRoot == null) firstLegalRoot = vertexId;
      }
    }
    checkBudget();
    const priorities = new Map(legal.map((move) => [move.vertexId, move.isAttack ? 1 : 0]));
    const ordered = rankTopologyCandidates(engine.compiledBoard, legal.map((move) => move.vertexId), {
      anchorVertexIds: engine._getPlayerNodes(actor)
    }).map((move) => move.vertexId);
    checkBudget();
    ordered.sort((a, b) => priorities.get(b) - priorities.get(a));
    return [...ordered, TOPOLOGY_AI_PASS];
  }, "orderedActions");
  const withAction = /* @__PURE__ */ __name((action, visit) => {
    const state = engine._captureTopologyState();
    const actor = engine.currentPlayer;
    const isOpponentAction = actor !== aiPlayer;
    let counted = false;
    try {
      const result = action === TOPOLOGY_AI_PASS ? engine.skipTurn() : engine.playMove(action);
      if (!result.success) throw new Error("Search generated an illegal topology action: " + result.reason);
      nodes += 1;
      if (isOpponentAction) {
        opponentActions++;
        opponentActionCounts.set(actor, (opponentActionCounts.get(actor) ?? 0) + 1);
        counted = true;
      }
      maxOpponentActionsOnVisitedPath = Math.max(maxOpponentActionsOnVisitedPath, opponentActions);
      if (opponentActionCounts.size) {
        maxOpponentRoundsOnVisitedPath = Math.max(
          maxOpponentRoundsOnVisitedPath,
          Math.min(...opponentActionCounts.values())
        );
      }
      return visit();
    } finally {
      if (counted) {
        opponentActions--;
        opponentActionCounts.set(actor, opponentActionCounts.get(actor) - 1);
      }
      engine._restoreTopologyState(state);
    }
  }, "withAction");
  const descend = /* @__PURE__ */ __name((depth) => {
    checkBudget();
    if (engine.gameOver || depth === 0) return evaluate3();
    const actorIndex = playerIndex.get(engine.currentPlayer);
    const actions = orderedActions();
    let best = null;
    for (const action of actions) {
      checkBudget();
      const value = withAction(action, () => descend(depth - 1));
      if (best == null || value[actorIndex] > best[actorIndex]) best = value;
    }
    return best ?? evaluate3();
  }, "descend");
  const sortResults = /* @__PURE__ */ __name((results) => results.sort((a, b) => b.score - a.score || a.order - b.order), "sortResults");
  try {
    engine._isReplayingBatch = true;
    engine.deferTerritoryUpdates = true;
    engine._hasValidMoves = function(player) {
      for (const vertexId of this.validPositions) {
        checkBudget();
        if (this._evaluateMove(vertexId, player).legal) return true;
      }
      return false;
    };
    try {
      legalRoots = orderedActions();
      legalEnumerationComplete = true;
    } catch (error) {
      if (error !== LIMIT) throw error;
      budgetExceeded = true;
      legalRoots = firstLegalRoot == null ? [] : [firstLegalRoot];
    }
    rootCount = legalRoots.length;
    if (!budgetExceeded && engine.consecutiveSkips >= engine._getRemainingPlayers().length - 1) {
      let winsByPass = false;
      try {
        checkBudget();
        winsByPass = withAction(TOPOLOGY_AI_PASS, () => {
          checkBudget();
          const won = engine.gameOver && engine.getWinner() === aiPlayer;
          checkBudget();
          return won;
        });
      } catch (error) {
        if (error !== LIMIT) throw error;
        budgetExceeded = true;
      }
      if (winsByPass) {
        completed = [{ action: TOPOLOGY_AI_PASS, score: 1e8, order: rootCount - 1 }];
      }
    }
    if (!completed.length && !budgetExceeded) {
      for (let depth = 1; depth <= maxDepth; depth += 1) {
        const iteration = [];
        const iterationStartNodes = nodes;
        try {
          for (let order3 = 0; order3 < legalRoots.length; order3 += 1) {
            checkBudget();
            const action = legalRoots[order3];
            const value = withAction(action, () => descend(depth - 1));
            iteration.push({ action, score: value[aiIndex], order: order3 });
          }
          completed = sortResults(iteration);
          completedDepth = depth;
        } catch (error) {
          if (error !== LIMIT) throw error;
          budgetExceeded = true;
          if (!completed.length) partial = sortResults(iteration);
          else partialIterationDiscarded = nodes > iterationStartNodes;
          break;
        }
      }
    }
    const candidates = completed.length ? completed : partial;
    const fallback = candidates.length ? candidates : legalRoots.length ? [{ action: legalRoots[0], score: null, order: 0 }] : [];
    const moves = fallback.slice(0, topN).map(({ action, score }) => action === TOPOLOGY_AI_PASS ? { type: "pass", point: null, score } : { type: "move", point: action, vertexId: action, score });
    return {
      moves,
      searchInfo: {
        algorithm: "bounded-max-n-v1",
        completedDepth,
        requestedDepth: maxDepth,
        nodes,
        maxOpponentActionsOnVisitedPath,
        maxOpponentRoundsOnVisitedPath,
        rootCount,
        evaluatedRoots: completedDepth ? rootCount : partial.length,
        budgetExceeded,
        legalEnumerationComplete,
        partialIterationDiscarded,
        selective: completedDepth === 0 && !completed.length,
        fallback: !completed.length,
        fallbackReason: !completed.length ? partial.length ? "partial-first-iteration" : legalRoots.length ? "legal-action-after-budget" : "no-action-before-budget" : null,
        terminalPassWin: completedDepth === 0 && completed[0]?.action === TOPOLOGY_AI_PASS,
        elapsedMs: Math.round((now() - started) * 100) / 100,
        strengthVerified: false
      }
    };
  } finally {
    engine._restoreTopologyState(original);
    engine._isReplayingBatch = originalBatch;
    engine.deferTerritoryUpdates = originalDefer;
    if (hadOwnHasValidMoves) engine._hasValidMoves = originalHasValidMoves;
    else delete engine._hasValidMoves;
  }
}
var now, LIMIT;
var init_TopologySearchAI = __esm({
  "application-hard:TopologySearchAI.js"() {
    init_TopologyAIAdapter();
    init_RootStability();
    init_EncirclementFeatures();
    now = /* @__PURE__ */ __name(() => globalThis.performance?.now?.() ?? Date.now(), "now");
    LIMIT = Symbol("topology-search-budget");
    __name(searchTopologyMoves, "searchTopologyMoves");
  }
});

// application-hard:BoardPaths.js
function pathError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function isPlainObject4(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
function coordinateKey(coordinate) {
  return coordinate[0] + "," + coordinate[1];
}
function rawEdgeKey2(left, right) {
  return undirectedKey(left, right);
}
function unfoldedDirection(index, transition, directionIndex2) {
  const source = transition.sourceFaceSide;
  const target = transition.targetFaceSide;
  const coordinate = /* @__PURE__ */ __name((id) => index.rawCoordinates.get(id), "coordinate");
  const s0 = coordinate(source.orientedVertices[0]);
  const s1 = coordinate(source.orientedVertices[1]);
  const t0 = coordinate(target.orientedVertices[transition.endpointMap[0]]);
  const t1 = coordinate(target.orientedVertices[transition.endpointMap[1]]);
  const si = coordinate(source.interiorVertexId);
  const ti = coordinate(target.interiorVertexId);
  const tangent = /* @__PURE__ */ __name((a, b) => triangularDirectionIndex(a, b), "tangent");
  const side = /* @__PURE__ */ __name((a, b, p) => Math.sign((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])), "side");
  const s = tangent(s0, s1), t = tangent(t0, t1);
  const orientation = side(s0, s1, si) === side(t0, t1, ti) ? -1 : 1;
  return ((t + orientation * (directionIndex2 - s)) % 6 + 6) % 6;
}
function deepCloneCoverage(position) {
  return Object.fromEntries(Object.entries(position.coverageByPlayer).map(([playerId, vertexIds]) => [playerId, [...vertexIds]]));
}
function normalizeTopologyPosition(board, position) {
  if (!isPlainObject4(position) || !isPlainObject4(position.coverageByPlayer)) {
    throw pathError("INVALID_POSITION", "Position requires a coverageByPlayer object.");
  }
  const sampleIds = new Set(board.sampleIds ?? []);
  const ownerByVertexId = /* @__PURE__ */ new Map();
  const normalized = {};
  for (const [playerId, coverage] of Object.entries(position.coverageByPlayer)) {
    if (typeof playerId !== "string" || !Array.isArray(coverage)) {
      throw pathError("INVALID_POSITION", "Each player coverage must be an array.");
    }
    const seen = /* @__PURE__ */ new Set();
    normalized[playerId] = [];
    for (const vertexId of coverage) {
      if (typeof vertexId !== "string" || !sampleIds.has(vertexId)) {
        throw pathError("UNKNOWN_POSITION_VERTEX", "Unknown canonical vertex: " + vertexId);
      }
      if (seen.has(vertexId)) {
        throw pathError("DUPLICATE_POSITION_COVERAGE", "Duplicate coverage for " + vertexId);
      }
      seen.add(vertexId);
      const existingOwner = ownerByVertexId.get(vertexId);
      if (existingOwner && existingOwner !== playerId) {
        throw pathError("POSITION_OVERLAP", "Multiple players cover " + vertexId);
      }
      ownerByVertexId.set(vertexId, playerId);
      normalized[playerId].push(vertexId);
    }
  }
  return { position: { coverageByPlayer: normalized }, ownerByVertexId };
}
function normalizeDirectionState(directionState) {
  const value = Number.isInteger(directionState) ? { directionIndex: directionState } : directionState;
  if (!isPlainObject4(value) || !Number.isInteger(value.directionIndex) || value.directionIndex < 0 || value.directionIndex >= TRIANGULAR_UNIT_DIRECTIONS.length) {
    throw pathError("INVALID_DIRECTION_STATE", "directionState must be 0..5 or an object with directionIndex.");
  }
  if (value.atlasVertexId != null && typeof value.atlasVertexId !== "string") {
    throw pathError("INVALID_DIRECTION_STATE", "atlasVertexId must be a source vertex id.");
  }
  if (value.maxSteps != null && (!Number.isInteger(value.maxSteps) || value.maxSteps < 1)) {
    throw pathError("INVALID_DIRECTION_STATE", "maxSteps must be a positive integer.");
  }
  return {
    directionIndex: value.directionIndex,
    atlasVertexId: value.atlasVertexId ?? null,
    maxSteps: value.maxSteps ?? null
  };
}
function buildTraversalIndex(board) {
  if (!board?.definition || !Array.isArray(board.definition.vertices) || !Array.isArray(board.definition.faces) || !board.rawVertexToCanonical) {
    throw pathError("INVALID_COMPILED_BOARD", "A compiled board-definition-v1 board is required.");
  }
  const cached = traversalIndexCache.get(board);
  if (cached) return cached;
  const rawCoordinates = /* @__PURE__ */ new Map();
  const rawVertexByCoordinate = /* @__PURE__ */ new Map();
  for (const vertex of board.definition.vertices) {
    rawCoordinates.set(vertex.id, vertex.coordinate);
    rawVertexByCoordinate.set(coordinateKey(vertex.coordinate), vertex.id);
  }
  const rawAdjacency = new Map(board.definition.vertices.map((vertex) => [vertex.id, /* @__PURE__ */ new Set()]));
  const rawEdgeOccurrences = /* @__PURE__ */ new Map();
  for (const occurrence of board.edgeOccurrences ?? []) {
    const [left, right] = occurrence.vertices;
    rawAdjacency.get(left)?.add(right);
    rawAdjacency.get(right)?.add(left);
    const key3 = rawEdgeKey2(left, right);
    const values = rawEdgeOccurrences.get(key3) ?? [];
    values.push(occurrence.id);
    rawEdgeOccurrences.set(key3, values);
  }
  for (const values of rawEdgeOccurrences.values()) values.sort();
  const rawCopiesByCanonical = /* @__PURE__ */ new Map();
  for (const [rawVertexId, canonicalVertexId] of Object.entries(board.rawVertexToCanonical)) {
    const values = rawCopiesByCanonical.get(canonicalVertexId) ?? [];
    values.push(rawVertexId);
    rawCopiesByCanonical.set(canonicalVertexId, values);
  }
  for (const values of rawCopiesByCanonical.values()) values.sort();
  const seamExits = /* @__PURE__ */ new Map();
  for (const transition of board.directionTransitions ?? []) {
    for (const rule of transition.endpointTransport ?? []) {
      const sourceRawVertexId = transition.sourceFaceSide?.orientedVertices?.[rule.sourceEndpointIndex];
      const targetRawVertexId = transition.targetFaceSide?.orientedVertices?.[rule.targetEndpointIndex];
      if (!sourceRawVertexId || !targetRawVertexId) continue;
      const key3 = sourceRawVertexId + "|" + rule.sourceExitDirectionIndex;
      const values = seamExits.get(key3) ?? [];
      values.push({
        transition,
        rule,
        sourceRawVertexId,
        targetRawVertexId
      });
      seamExits.set(key3, values);
    }
  }
  const index = {
    rawCoordinates,
    rawVertexByCoordinate,
    rawAdjacency,
    rawEdgeOccurrences,
    rawCopiesByCanonical,
    seamExits,
    realBoundary: new Set(board.realBoundarySampleIds ?? []),
    specialVertices: new Set((board.specialVertices ?? []).map((vertex) => vertex.id)),
    stopOnEntry: new Set((board.specialVertices ?? []).filter((v) => !v.manifold || v.kind === "cycle" && v.incidentEdgeClassCount !== 6).map((v) => v.id))
  };
  if (Object.isFrozen(board)) traversalIndexCache.set(board, index);
  return index;
}
function transportDirectionAcrossSeam(board, transition, directionIndex2) {
  if (!Number.isInteger(directionIndex2) || directionIndex2 < 0 || directionIndex2 >= 6) {
    throw pathError("INVALID_DIRECTION_STATE", "directionIndex must be 0..5.");
  }
  return unfoldedDirection(buildTraversalIndex(board), transition, directionIndex2);
}
function regularStep(index, rawVertexId, directionIndex2) {
  const coordinate = index.rawCoordinates.get(rawVertexId);
  const [dx, dy] = TRIANGULAR_UNIT_DIRECTIONS[directionIndex2];
  const nextRawVertexId = index.rawVertexByCoordinate.get(coordinateKey([coordinate[0] + dx, coordinate[1] + dy]));
  if (!nextRawVertexId || !index.rawAdjacency.get(rawVertexId)?.has(nextRawVertexId)) return null;
  const occurrenceIds = index.rawEdgeOccurrences.get(rawEdgeKey2(rawVertexId, nextRawVertexId)) ?? [];
  return { nextRawVertexId, occurrenceIds };
}
function continuationKind(index, rawVertexId, directionIndex2) {
  const direct = regularStep(index, rawVertexId, directionIndex2);
  if (direct) return { kind: "regular", ...direct };
  const exits = index.seamExits.get(rawVertexId + "|" + directionIndex2) ?? [];
  if (exits.length === 1) return { kind: "seam", ...exits[0] };
  if (exits.length > 1) return { kind: "ambiguous-seam" };
  return { kind: "none" };
}
function selectInitialRawCopy(board, index, canonicalVertexId, direction) {
  if (direction.atlasVertexId != null) {
    if (board.rawVertexToCanonical[direction.atlasVertexId] !== canonicalVertexId) {
      throw pathError("INVALID_ATLAS_VERTEX", "atlasVertexId is not a copy of " + canonicalVertexId);
    }
    return direction.atlasVertexId;
  }
  const copies = index.rawCopiesByCanonical.get(canonicalVertexId) ?? [];
  const candidates = copies.filter(
    (rawVertexId) => continuationKind(index, rawVertexId, direction.directionIndex).kind !== "none"
  );
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0 && copies.length === 1) return copies[0];
  if (candidates.length === 0 && copies.length > 1) {
    throw pathError("AMBIGUOUS_ATLAS_COPY", "No direction-selectable atlas copy exists for " + canonicalVertexId);
  }
  throw pathError(
    "AMBIGUOUS_ATLAS_COPY",
    "Multiple atlas copies could continue; provide directionState.atlasVertexId."
  );
}
function defaultStepBudget(board) {
  return Math.max(1, (board.sampleIds?.length ?? 1) * TRIANGULAR_UNIT_DIRECTIONS.length + (board.directionTransitions?.length ?? 0) * 2);
}
function stopResult({
  vertices,
  edgeOccurrences,
  seamCrossings,
  stopReason,
  steps,
  blockedVertexId = null,
  blockedByPlayerId = null
}) {
  return {
    vertices,
    edgeOccurrences,
    seamCrossings,
    stopReason,
    steps,
    ...blockedVertexId ? { blockedVertexId } : {},
    ...blockedByPlayerId ? { blockedByPlayerId } : {}
  };
}
function traceRay(board, position, fromVertexId, directionState) {
  const normalizedPosition = normalizeTopologyPosition(board, position);
  const direction = normalizeDirectionState(directionState);
  if (!(board.sampleIds ?? []).includes(fromVertexId)) {
    throw pathError("UNKNOWN_START_VERTEX", "Unknown canonical start: " + fromVertexId);
  }
  const index = buildTraversalIndex(board);
  const maxSteps = direction.maxSteps ?? defaultStepBudget(board);
  let rawVertexId;
  try {
    rawVertexId = selectInitialRawCopy(board, index, fromVertexId, direction);
  } catch (error) {
    if (error?.code === "AMBIGUOUS_ATLAS_COPY") {
      return stopResult({
        vertices: [fromVertexId],
        edgeOccurrences: [],
        seamCrossings: [],
        stopReason: RayStopReason.SPECIAL_VERTEX,
        steps: 0
      });
    }
    throw error;
  }
  let canonicalVertexId = fromVertexId;
  let currentDirection = direction.directionIndex;
  const vertices = [canonicalVertexId];
  const edgeOccurrences = [];
  const seamCrossings = [];
  const visitedStates = /* @__PURE__ */ new Set();
  let steps = 0;
  while (steps < maxSteps) {
    const stateKey = canonicalVertexId + "|" + rawVertexId + "|" + currentDirection;
    if (visitedStates.has(stateKey)) {
      return stopResult({
        vertices,
        edgeOccurrences,
        seamCrossings,
        stopReason: RayStopReason.REPEATED_STATE,
        steps
      });
    }
    visitedStates.add(stateKey);
    const continuation = continuationKind(index, rawVertexId, currentDirection);
    if (continuation.kind === "regular") {
      steps += 1;
      rawVertexId = continuation.nextRawVertexId;
      canonicalVertexId = board.rawVertexToCanonical[rawVertexId];
      edgeOccurrences.push(...continuation.occurrenceIds);
      vertices.push(canonicalVertexId);
      const owner = normalizedPosition.ownerByVertexId.get(canonicalVertexId);
      if (owner) {
        return stopResult({
          vertices,
          edgeOccurrences,
          seamCrossings,
          stopReason: RayStopReason.BLOCKED,
          steps,
          blockedVertexId: canonicalVertexId,
          blockedByPlayerId: owner
        });
      }
      if (index.stopOnEntry.has(canonicalVertexId)) {
        return stopResult({
          vertices,
          edgeOccurrences,
          seamCrossings,
          stopReason: RayStopReason.SPECIAL_VERTEX,
          steps
        });
      }
      continue;
    }
    if (continuation.kind === "seam") {
      steps += 1;
      const { transition, rule, sourceRawVertexId, targetRawVertexId } = continuation;
      seamCrossings.push({
        fromEdgeOccurrenceId: transition.fromEdgeOccurrenceId,
        toEdgeOccurrenceId: transition.toEdgeOccurrenceId,
        sourceVertexId: sourceRawVertexId,
        targetVertexId: targetRawVertexId,
        sourceEndpointIndex: rule.sourceEndpointIndex,
        targetEndpointIndex: rule.targetEndpointIndex,
        sourceDirectionState: rule.sourceExitDirectionIndex,
        targetDirectionState: rule.targetEntryDirectionIndex
      });
      rawVertexId = targetRawVertexId;
      canonicalVertexId = board.rawVertexToCanonical[rawVertexId];
      currentDirection = board.definition.topology.movementStrategy === "simple-rays-v3" ? unfoldedDirection(index, transition, currentDirection) : rule.targetEntryDirectionIndex;
      seamCrossings[seamCrossings.length - 1].targetDirectionState = currentDirection;
      continue;
    }
    if (continuation.kind === "ambiguous-seam") {
      return stopResult({
        vertices,
        edgeOccurrences,
        seamCrossings,
        stopReason: RayStopReason.SPECIAL_VERTEX,
        steps
      });
    }
    if (index.realBoundary.has(canonicalVertexId)) {
      return stopResult({
        vertices,
        edgeOccurrences,
        seamCrossings,
        stopReason: RayStopReason.REAL_BOUNDARY,
        steps
      });
    }
    if (index.specialVertices.has(canonicalVertexId)) {
      return stopResult({
        vertices,
        edgeOccurrences,
        seamCrossings,
        stopReason: RayStopReason.SPECIAL_VERTEX,
        steps
      });
    }
    return stopResult({
      vertices,
      edgeOccurrences,
      seamCrossings,
      stopReason: RayStopReason.NO_CONTINUATION,
      steps
    });
  }
  return stopResult({
    vertices,
    edgeOccurrences,
    seamCrossings,
    stopReason: RayStopReason.BUDGET_EXCEEDED,
    steps
  });
}
function reverseSeamCrossingKey(crossing) {
  return crossing.toEdgeOccurrenceId + ">" + crossing.fromEdgeOccurrenceId + "@" + crossing.targetVertexId + ":" + crossing.sourceVertexId;
}
function pathFingerprint(connection) {
  const forward2 = [
    connection.vertices.join(">"),
    connection.edgeOccurrences.join(","),
    connection.seamCrossings.map((crossing) => crossing.fromEdgeOccurrenceId + ">" + crossing.toEdgeOccurrenceId + "@" + crossing.sourceVertexId + ":" + crossing.targetVertexId).join(",")
  ].join("|");
  const reverse = [
    [...connection.vertices].reverse().join(">"),
    [...connection.edgeOccurrences].reverse().join(","),
    [...connection.seamCrossings].reverse().map(reverseSeamCrossingKey).join(",")
  ].join("|");
  return forward2 < reverse ? forward2 : reverse;
}
function physicalPathKey(board, connection) {
  let classByOccurrence = edgeClassIndexCache.get(board);
  if (!classByOccurrence) {
    classByOccurrence = /* @__PURE__ */ new Map();
    for (const edgeClass of board.edgeClasses ?? []) {
      for (const occurrence of edgeClass.occurrences ?? []) classByOccurrence.set(occurrence.id, edgeClass.id);
    }
    if (Object.isFrozen(board)) edgeClassIndexCache.set(board, classByOccurrence);
  }
  const classes = [];
  for (const occurrenceId of connection.edgeOccurrences ?? []) {
    const id = classByOccurrence.get(occurrenceId) ?? occurrenceId;
    if (classes.at(-1) !== id) classes.push(id);
  }
  const vertices = connection.vertices ?? [];
  const forward2 = JSON.stringify([vertices, classes]);
  const reverse = JSON.stringify([[...vertices].reverse(), [...classes].reverse()]);
  return forward2 < reverse ? forward2 : reverse;
}
function pendingPlacementPosition(position, playerId, newVertexId) {
  const coverageByPlayer = deepCloneCoverage(position);
  const coverage = coverageByPlayer[playerId] ?? [];
  if (!coverage.includes(newVertexId)) coverage.push(newVertexId);
  coverageByPlayer[playerId] = coverage;
  return { coverageByPlayer };
}
function enumerateConnections(board, position, newVertexId, playerId, options = {}) {
  if (typeof playerId !== "string" || !playerId) {
    throw pathError("INVALID_PLAYER", "playerId must be a non-empty string.");
  }
  const normalizedPosition = normalizeTopologyPosition(board, position);
  if (!(board.sampleIds ?? []).includes(newVertexId)) {
    throw pathError("UNKNOWN_START_VERTEX", "Unknown canonical start: " + newVertexId);
  }
  if (normalizedPosition.ownerByVertexId.has(newVertexId)) return [];
  const connections = [];
  const fingerprints = /* @__PURE__ */ new Set();
  const ownTargets = position.nodesByPlayer?.[playerId] ?? normalizedPosition.position.coverageByPlayer[playerId] ?? [];
  const copies = board.canonicalVertices.find((vertex) => vertex.id === newVertexId)?.sourceVertexIds ?? [];
  for (const target of ownTargets) {
    if (target === newVertexId) continue;
    if (!normalizedPosition.position.coverageByPlayer[playerId]?.includes(target)) {
      throw pathError("INVALID_POSITION", "A node must be covered by its owner: " + target);
    }
    const coverageByPlayer = Object.fromEntries(Object.entries(normalizedPosition.position.coverageByPlayer).map(([owner, coverage]) => [owner, owner === playerId ? [target] : [...coverage]]));
    const pending2 = pendingPlacementPosition({ coverageByPlayer }, playerId, newVertexId);
    for (const atlasVertexId of copies) {
      for (let directionIndex2 = 0; directionIndex2 < TRIANGULAR_UNIT_DIRECTIONS.length; directionIndex2 += 1) {
        const trace = traceRay(board, pending2, newVertexId, { directionIndex: directionIndex2, atlasVertexId });
        if (trace.stopReason !== RayStopReason.BLOCKED || trace.blockedByPlayerId !== playerId || trace.blockedVertexId !== target) continue;
        const connection = {
          startVertexId: newVertexId,
          endVertexId: trace.blockedVertexId,
          vertices: [...trace.vertices],
          edgeOccurrences: [...trace.edgeOccurrences],
          seamCrossings: trace.seamCrossings.map((crossing) => ({ ...crossing })),
          directionState: directionIndex2
        };
        const fingerprint = pathFingerprint(connection);
        if (fingerprints.has(fingerprint)) continue;
        fingerprints.add(fingerprint);
        connection.pathId = "path:v1:" + sha256Hex(fingerprint).slice(0, 24);
        connections.push(connection);
      }
    }
  }
  connections.sort((left, right) => compareStableIdentifiers(left.pathId, right.pathId));
  const strategy = board.definition.topology.movementStrategy;
  if (strategy !== "simple-rays-v2" && strategy !== "simple-rays-v3" || options.geometryOnly) return connections;
  const covered = new Set(normalizedPosition.position.coverageByPlayer[playerId] ?? []);
  const selected = [];
  const occupied = /* @__PURE__ */ new Set();
  const interiors = /* @__PURE__ */ new Set();
  const physicalPaths = /* @__PURE__ */ new Set();
  for (const connection of connections) {
    const tail = connection.vertices.slice(1);
    const inner = connection.vertices.slice(1, -1);
    if (new Set(connection.vertices).size !== connection.vertices.length) continue;
    if (inner.some((id) => covered.has(id))) continue;
    if (inner.some((id) => occupied.has(id)) || interiors.has(connection.endVertexId)) continue;
    const physicalKey = strategy === "simple-rays-v3" ? physicalPathKey(board, connection) : null;
    if (physicalKey != null && physicalPaths.has(physicalKey)) continue;
    selected.push(connection);
    if (physicalKey != null) physicalPaths.add(physicalKey);
    for (const id of tail) occupied.add(id);
    for (const id of inner) interiors.add(id);
  }
  return selected;
}
function indexConnectionCoverage(connections) {
  const byVertexId = {};
  const byEdgeOccurrenceId = {};
  for (const connection of connections) {
    for (const vertexId of connection.vertices) {
      const values = byVertexId[vertexId] ?? [];
      values.push(connection.pathId);
      byVertexId[vertexId] = values;
    }
    for (const edgeOccurrenceId2 of connection.edgeOccurrences) {
      const values = byEdgeOccurrenceId[edgeOccurrenceId2] ?? [];
      values.push(connection.pathId);
      byEdgeOccurrenceId[edgeOccurrenceId2] = values;
    }
  }
  for (const values of Object.values(byVertexId)) values.sort();
  for (const values of Object.values(byEdgeOccurrenceId)) values.sort();
  return { byVertexId, byEdgeOccurrenceId };
}
var PATH_RULE_VERSION, RayStopReason, traversalIndexCache, edgeClassIndexCache;
var init_BoardPaths = __esm({
  "application-hard:BoardPaths.js"() {
    init_BoardDefinition();
    PATH_RULE_VERSION = "simple-rays-v1";
    RayStopReason = Object.freeze({
      REAL_BOUNDARY: "REAL_BOUNDARY",
      BLOCKED: "BLOCKED",
      REPEATED_STATE: "REPEATED_STATE",
      SPECIAL_VERTEX: "SPECIAL_VERTEX",
      BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
      NO_CONTINUATION: "NO_CONTINUATION"
    });
    __name(pathError, "pathError");
    __name(isPlainObject4, "isPlainObject");
    __name(coordinateKey, "coordinateKey");
    __name(rawEdgeKey2, "rawEdgeKey");
    __name(unfoldedDirection, "unfoldedDirection");
    __name(deepCloneCoverage, "deepCloneCoverage");
    __name(normalizeTopologyPosition, "normalizeTopologyPosition");
    __name(normalizeDirectionState, "normalizeDirectionState");
    traversalIndexCache = /* @__PURE__ */ new WeakMap();
    __name(buildTraversalIndex, "buildTraversalIndex");
    __name(transportDirectionAcrossSeam, "transportDirectionAcrossSeam");
    __name(regularStep, "regularStep");
    __name(continuationKind, "continuationKind");
    __name(selectInitialRawCopy, "selectInitialRawCopy");
    __name(defaultStepBudget, "defaultStepBudget");
    __name(stopResult, "stopResult");
    __name(traceRay, "traceRay");
    __name(reverseSeamCrossingKey, "reverseSeamCrossingKey");
    __name(pathFingerprint, "pathFingerprint");
    edgeClassIndexCache = /* @__PURE__ */ new WeakMap();
    __name(physicalPathKey, "physicalPathKey");
    __name(pendingPlacementPosition, "pendingPlacementPosition");
    __name(enumerateConnections, "enumerateConnections");
    __name(indexConnectionCoverage, "indexConnectionCoverage");
  }
});

// application-hard:SurfaceTerritory.js
function valuesForKey(source, key3) {
  if (source instanceof Map) return source.get(key3) ?? [];
  return source?.[key3] ?? [];
}
function uniqueIds(value, label, allowed) {
  if (!Array.isArray(value) && !(value instanceof Set)) {
    throw new TypeError(label + " must be an array or Set.");
  }
  const result = [];
  const seen = /* @__PURE__ */ new Set();
  for (const id of value) {
    if (typeof id !== "string") throw new TypeError(label + " contains a non-string sample ID.");
    if (!allowed.has(id)) throw new Error("UNKNOWN_SAMPLE:" + id);
    if (seen.has(id)) throw new Error("DUPLICATE_SAMPLE:" + id);
    seen.add(id);
    result.push(id);
  }
  return result;
}
function playerCoverage(position, playerId, allowed) {
  const direct = valuesForKey(position.ownedSampleIdsByPlayer, playerId);
  if (direct.length) return uniqueIds(direct, "ownedSampleIdsByPlayer." + playerId, allowed);
  const detail = valuesForKey(position.samplesByPlayer, playerId);
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const nodes = detail.nodeSampleIds ?? [];
    const lines = detail.lineSampleIds ?? [];
    return uniqueIds([...nodes, ...lines], "samplesByPlayer." + playerId, allowed);
  }
  return [];
}
function allEnemyCoverage(position, playerId, allowed) {
  const result = /* @__PURE__ */ new Set();
  const direct = position.ownedSampleIdsByPlayer;
  if (direct) {
    for (const [owner, values] of asEntries(direct)) {
      if (owner === playerId) continue;
      for (const id of uniqueIds(values, "ownedSampleIdsByPlayer." + owner, allowed)) result.add(id);
    }
  }
  const detailed = position.samplesByPlayer;
  if (detailed) {
    for (const [owner, detail] of asEntries(detailed)) {
      if (owner === playerId || !detail || typeof detail !== "object") continue;
      for (const id of uniqueIds(
        [...detail.nodeSampleIds ?? [], ...detail.lineSampleIds ?? []],
        "samplesByPlayer." + owner,
        allowed
      )) result.add(id);
    }
  }
  return result;
}
function normalizeBoard(board) {
  if (!board || typeof board !== "object") throw new TypeError("board is required.");
  if (!Array.isArray(board.sampleIds) || board.sampleIds.length === 0) {
    throw new TypeError("board.sampleIds must be a non-empty array.");
  }
  const sampleIds = uniqueIds(board.sampleIds, "board.sampleIds", new Set(board.sampleIds));
  const samples = new Set(sampleIds);
  const adjacency = /* @__PURE__ */ new Map();
  for (const id of sampleIds) {
    const neighbors = uniqueIds(valuesForKey(board.sampleAdjacency, id), "sampleAdjacency." + id, samples);
    adjacency.set(id, neighbors);
  }
  for (const [id, neighbors] of adjacency) {
    for (const neighbor of neighbors) {
      if (!adjacency.get(neighbor).includes(id)) {
        throw new Error("ASYMMETRIC_ADJACENCY:" + id + ":" + neighbor);
      }
    }
  }
  const realBoundary = new Set(uniqueIds(board.realBoundarySampleIds ?? [], "realBoundarySampleIds", samples));
  const weights = /* @__PURE__ */ new Map();
  for (const id of sampleIds) {
    const rawWeight = board.sampleWeights instanceof Map ? board.sampleWeights.get(id) : board.sampleWeights?.[id];
    const weight = rawWeight === void 0 ? 1 : rawWeight;
    if (!Number.isFinite(weight) || weight <= 0) throw new Error("INVALID_SAMPLE_WEIGHT:" + id);
    weights.set(id, weight);
  }
  return { sampleIds, samples, adjacency, realBoundary, weights };
}
function computeTerritory(board, position, playerId) {
  if (typeof playerId !== "string" || !playerId) throw new TypeError("playerId is required.");
  if (!position || typeof position !== "object") throw new TypeError("position is required.");
  const normalized = normalizeBoard(board);
  const ownedSampleIds = playerCoverage(position, playerId, normalized.samples);
  const owned = new Set(ownedSampleIds);
  const enemies = allEnemyCoverage(position, playerId, normalized.samples);
  for (const id of owned) {
    if (enemies.has(id)) throw new Error("POSITION_OVERLAP:" + id);
  }
  let area = 0;
  for (const id of owned) area += normalized.weights.get(id);
  const seen = new Set(owned);
  const enclosedSampleIds = [];
  const components = [];
  for (const root of normalized.sampleIds) {
    if (seen.has(root)) continue;
    const queue = [root];
    const sampleIds = [];
    let cursor = 0;
    let weight = 0;
    let touchesRealBoundary = false;
    let containsEnemy = false;
    seen.add(root);
    while (cursor < queue.length) {
      const id = queue[cursor++];
      sampleIds.push(id);
      weight += normalized.weights.get(id);
      touchesRealBoundary ||= normalized.realBoundary.has(id);
      containsEnemy ||= enemies.has(id);
      for (const neighbor of normalized.adjacency.get(id)) {
        if (seen.has(neighbor) || owned.has(neighbor)) continue;
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
    const counted = !touchesRealBoundary && !containsEnemy;
    if (counted) {
      area += weight;
      enclosedSampleIds.push(...sampleIds);
    }
    components.push({
      sampleIds,
      weight,
      touchesRealBoundary,
      containsEnemy,
      counted
    });
  }
  return {
    area,
    ownedSampleIds,
    enclosedSampleIds,
    components
  };
}
var asEntries;
var init_SurfaceTerritory = __esm({
  "application-hard:SurfaceTerritory.js"() {
    asEntries = /* @__PURE__ */ __name((value) => value instanceof Map ? value.entries() : Object.entries(value ?? {}), "asEntries");
    __name(valuesForKey, "valuesForKey");
    __name(uniqueIds, "uniqueIds");
    __name(playerCoverage, "playerCoverage");
    __name(allEnemyCoverage, "allEnemyCoverage");
    __name(normalizeBoard, "normalizeBoard");
    __name(computeTerritory, "computeTerritory");
  }
});

// application-hard:TopologyStartingPoints.js
function prepareTopologyNewMatchSettings(settings) {
  const definition = settings?.boardDefinition;
  const strategy = definition?.topology?.movementStrategy ?? "simple-rays-v1";
  if (!definition || !["simple-rays-v1", "simple-rays-v2"].includes(strategy)) return settings;
  const candidate = JSON.parse(JSON.stringify(definition));
  candidate.topology = { ...candidate.topology, movementStrategy: "simple-rays-v3" };
  const result = compileBoard(candidate);
  if (!result.ok) fail2("INVALID_NEW_MATCH_TOPOLOGY", result.errors.map((error) => `${error.code}@${error.location}`).join(", "));
  return { ...settings, boardDefinition: result.value.definition, boardHash: result.value.boardHash };
}
function topologyStartingRoots(board) {
  return Object.fromEntries(Object.entries(board.startingRoots ?? board.startingVertices ?? {}).map(([player, value]) => [player, [...array(value)]]));
}
function topologyStartingState(board) {
  return Object.fromEntries(Object.entries(topologyStartingRoots(board)).map(([player, roots]) => [
    player,
    Array.isArray(board.definition?.startingVertices?.[player]) ? roots : roots[0]
  ]));
}
function normalizeTopologyRoots(board, players, requested = {}) {
  const samples = new Set(board.sampleIds);
  const aliases = /* @__PURE__ */ new Map();
  for (const copy of board.atlas.pointCopies) {
    const key3 = copy.coordinate.join(",");
    aliases.set(key3, aliases.has(key3) && aliases.get(key3) !== copy.canonicalVertexId ? null : copy.canonicalVertexId);
  }
  const resolve = /* @__PURE__ */ __name((value) => typeof value === "string" ? samples.has(value) ? value : board.rawVertexToCanonical[value] : Array.isArray(value) && value.length === 2 && value.every(Number.isInteger) ? aliases.get(value.join(",")) : null, "resolve");
  const existing = topologyStartingRoots(board);
  const claimed = /* @__PURE__ */ new Set();
  const result = {};
  for (const player of players) {
    const raw = requested[player] ?? existing[player];
    const values = Array.isArray(raw) && raw.length === 2 && raw.every(Number.isInteger) ? [raw] : array(raw);
    if (!values.length || values.length > MAX_TOPOLOGY_ROOTS_PER_PLAYER) fail2("INVALID_START_ROOT_COUNT", player);
    result[player] = values.map((value) => {
      const vertex = resolve(value);
      if (!vertex) fail2("UNKNOWN_START_VERTEX", player);
      if (claimed.has(vertex)) fail2("DUPLICATE_START_VERTEX", player);
      claimed.add(vertex);
      return vertex;
    }).sort(compareStableIdentifiers);
  }
  return result;
}
function distances(board, source) {
  const result = /* @__PURE__ */ new Map([[source, 0]]), queue = [source];
  for (let i = 0; i < queue.length; i += 1) {
    for (const next of board.sampleAdjacency[queue[i]] ?? []) {
      if (!result.has(next)) {
        result.set(next, result.get(queue[i]) + 1);
        queue.push(next);
      }
    }
  }
  return result;
}
function createTopologyStartingDefinition(board, options = {}) {
  const playerCount = options.playerCount ?? Math.max(2, Object.keys(board.startingVertices ?? {}).length);
  const count = options.countPerPlayer ?? 1;
  const mode = options.mode ?? "default";
  if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 6) fail2("INVALID_PLAYER_COUNT");
  if (!Number.isInteger(count) || count < 1 || count > MAX_TOPOLOGY_ROOTS_PER_PLAYER) fail2("INVALID_START_ROOT_COUNT");
  if (!["default", "random", "custom", "append-random"].includes(mode)) fail2("INVALID_STARTING_POINT_MODE");
  const players = PLAYERS.slice(0, playerCount);
  let roots;
  if (mode === "custom") {
    roots = normalizeTopologyRoots(board, players, options.roots ?? {});
  } else if (mode === "append-random") {
    if (!players.includes(options.player)) fail2("INVALID_START_PLAYER");
    roots = normalizeTopologyRoots(board, players);
    if (roots[options.player].length >= MAX_TOPOLOGY_ROOTS_PER_PLAYER) fail2("START_ROOTS_FULL", options.player);
    const claimed = new Set(Object.values(roots).flat());
    const candidates = [...board.sampleIds].filter((id) => !claimed.has(id)).sort(compareStableIdentifiers);
    if (!candidates.length) fail2("INSUFFICIENT_START_VERTICES");
    const value = (options.random ?? Math.random)();
    if (!(value >= 0 && value < 1)) fail2("INVALID_RANDOM_SAMPLE");
    roots[options.player].push(candidates[Math.floor(value * candidates.length)]);
    roots = normalizeTopologyRoots(board, players, roots);
  } else {
    if (playerCount * count > board.sampleIds.length) fail2("INSUFFICIENT_START_VERTICES");
    const available = [...board.sampleIds].sort(compareStableIdentifiers);
    const existing = topologyStartingRoots(board), claimed = /* @__PURE__ */ new Set(), distanceMaps = [];
    roots = Object.fromEntries(players.map((player) => [player, []]));
    const claim = /* @__PURE__ */ __name((player, vertex) => {
      roots[player].push(vertex);
      claimed.add(vertex);
      distanceMaps.push(distances(board, vertex));
    }, "claim");
    if (mode === "default") {
      for (const player of players) for (const vertex of (existing[player] ?? []).slice(0, count)) {
        if (!claimed.has(vertex)) claim(player, vertex);
      }
    }
    for (let slot = 0; slot < count; slot += 1) for (const player of players) {
      if (roots[player].length > slot) continue;
      const candidates = available.filter((id) => !claimed.has(id));
      let best = candidates[0];
      if (mode === "random") {
        const value = (options.random ?? Math.random)();
        if (!(value >= 0 && value < 1)) fail2("INVALID_RANDOM_SAMPLE");
        best = candidates[Math.floor(value * candidates.length)];
      } else {
        let bestDistance = -1;
        for (const candidate of candidates) {
          const distance = distanceMaps.length ? Math.min(...distanceMaps.map((map) => map.get(candidate) ?? Infinity)) : 0;
          if (distance > bestDistance) {
            bestDistance = distance;
            best = candidate;
          }
        }
      }
      claim(player, best);
    }
    roots = normalizeTopologyRoots(board, players, roots);
  }
  const sources = new Map(board.canonicalVertices.map((vertex) => [vertex.id, vertex.sourceVertexIds[0]]));
  const definition = JSON.parse(JSON.stringify(board.definition));
  definition.startingVertices = Object.fromEntries(players.map((player) => {
    const raw = roots[player].map((id) => sources.get(id));
    return [player, raw.length === 1 ? raw[0] : raw];
  }));
  const result = compileBoard(definition);
  if (!result.ok) fail2("INVALID_STARTING_LAYOUT", result.errors.map((error) => `${error.code}@${error.location}`).join(", "));
  return result.value.definition;
}
var PLAYERS, MAX_TOPOLOGY_ROOTS_PER_PLAYER, array, fail2;
var init_TopologyStartingPoints = __esm({
  "application-hard:TopologyStartingPoints.js"() {
    init_BoardCompiler();
    init_BoardDefinition();
    PLAYERS = ["BLACK", "WHITE", "PURPLE", "GREEN", "ORANGE", "CYAN"];
    MAX_TOPOLOGY_ROOTS_PER_PLAYER = 6;
    array = /* @__PURE__ */ __name((value) => Array.isArray(value) ? value : value == null ? [] : [value], "array");
    fail2 = /* @__PURE__ */ __name((code, detail = "") => {
      const error = new Error(`${code}${detail ? ": " + detail : ""}`);
      error.code = code;
      throw error;
    }, "fail");
    __name(prepareTopologyNewMatchSettings, "prepareTopologyNewMatchSettings");
    __name(topologyStartingRoots, "topologyStartingRoots");
    __name(topologyStartingState, "topologyStartingState");
    __name(normalizeTopologyRoots, "normalizeTopologyRoots");
    __name(distances, "distances");
    __name(createTopologyStartingDefinition, "createTopologyStartingDefinition");
  }
});

// application-hard:TopologyGameEngine.js
var TopologyGameEngine_exports = {};
__export(TopologyGameEngine_exports, {
  TopologyGameEngine: () => TopologyGameEngine,
  createTopologyGameEngine: () => createTopologyGameEngine
});
function sameStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
}
function sameSeamCrossings(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((crossing, index) => JSON.stringify(crossing) === JSON.stringify(right[index]));
}
function samePhysicalPath(left, right) {
  const forward2 = sameStringArray(left.vertices, right.vertices);
  const reverse = sameStringArray(left.vertices, [...right.vertices].reverse());
  if (!forward2 && !reverse) return false;
  if (!sameStringArray(sorted(left.edgeOccurrences), sorted(right.edgeOccurrences))) return false;
  const seamKey = /* @__PURE__ */ __name((crossing) => [
    [crossing.fromEdgeOccurrenceId, crossing.sourceVertexId].join("@"),
    [crossing.toEdgeOccurrenceId, crossing.targetVertexId].join("@")
  ].sort().join("|"), "seamKey");
  return sameStringArray(
    sorted((left.seamCrossings ?? []).map(seamKey)),
    sorted((right.seamCrossings ?? []).map(seamKey))
  );
}
function isExactCompiledConnection(left, right) {
  return left.pathId === right.pathId && left.startVertexId === right.startVertexId && left.endVertexId === right.endVertexId && left.directionState === right.directionState && sameStringArray(left.vertices, right.vertices) && sameStringArray(left.edgeOccurrences, right.edgeOccurrences) && sameSeamCrossings(left.seamCrossings, right.seamCrossings);
}
function assertExactCompiledConnection(board, path) {
  let candidates;
  try {
    candidates = enumerateConnections(board, {
      coverageByPlayer: { [path.owner]: [path.endVertexId] }
    }, path.startVertexId, path.owner, { geometryOnly: true });
  } catch (error) {
    throw topologyError("INVALID_LOGIC_PATH", path.pathId + ": " + (error?.code ?? error?.message ?? "cannot trace"));
  }
  if (!candidates.some((candidate) => isExactCompiledConnection(candidate, path))) {
    throw topologyError("INVALID_LOGIC_PATH", path.pathId + ": does not reproduce a compiled ray");
  }
}
function normalizeCompiledBoard(options) {
  if (options.compiledBoard) {
    const board = options.compiledBoard;
    if (!board || typeof board !== "object" || typeof board.boardHash !== "string" || !Array.isArray(board.sampleIds) || !board.definition) {
      throw topologyError("INVALID_COMPILED_BOARD");
    }
    const recompiled = compileBoard(board.definition);
    if (!recompiled.ok || recompiled.value.boardHash !== board.boardHash) {
      throw topologyError("INVALID_COMPILED_BOARD", "Definition does not reproduce boardHash.");
    }
    return recompiled.value;
  }
  const compiled = compileBoard(options.boardDefinition);
  if (!compiled.ok) {
    throw topologyError(
      "INVALID_BOARD_DEFINITION",
      compiled.errors.map((error) => error.code + "@" + error.location).join(", ")
    );
  }
  return compiled.value;
}
function graphDistances(board, start) {
  const distances2 = /* @__PURE__ */ new Map([[start, 0]]);
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const next of board.sampleAdjacency[current] ?? []) {
      if (!distances2.has(next)) {
        distances2.set(next, distances2.get(current) + 1);
        queue.push(next);
      }
    }
  }
  return distances2;
}
function selectInitialPositions(board, players, requested, aliases) {
  const starts = {};
  const claimed = /* @__PURE__ */ new Set();
  const resolve = /* @__PURE__ */ __name((value) => {
    if (typeof value === "string") {
      if (board.sampleIds.includes(value)) return value;
      return board.rawVertexToCanonical[value] ?? null;
    }
    if (Array.isArray(value) && value.length === 2 && value.every(Number.isInteger)) {
      return aliases.get(value.join(",")) ?? null;
    }
    return null;
  }, "resolve");
  for (const player of players) {
    const value = requested?.[player] ?? board.startingRoots?.[player] ?? board.startingVertices?.[player];
    if (value == null) continue;
    const values = Array.isArray(value) && !(value.length === 2 && value.every(Number.isInteger)) ? value : [value];
    if (!values.length || values.length > 6) throw topologyError("INVALID_START_ROOT_COUNT", player);
    starts[player] = values.map((root) => {
      const canonicalVertexId = resolve(root);
      if (!canonicalVertexId) throw topologyError("UNKNOWN_START_VERTEX", player);
      if (claimed.has(canonicalVertexId)) throw topologyError("DUPLICATE_START_VERTEX", player);
      claimed.add(canonicalVertexId);
      return canonicalVertexId;
    }).sort(compareStableIdentifiers);
  }
  const candidates = sorted(board.sampleIds);
  for (const player of players) {
    if (starts[player]) continue;
    const available = candidates.filter((id) => !claimed.has(id));
    if (!available.length) throw topologyError("INSUFFICIENT_START_VERTICES");
    if (!claimed.size) {
      starts[player] = [available[0]];
      claimed.add(available[0]);
      continue;
    }
    let best = available[0];
    let bestDistance = Number.NEGATIVE_INFINITY;
    for (const candidate of available) {
      const minimumDistance = Math.min(...[...claimed].map((source) => graphDistances(board, source).get(candidate) ?? Number.NEGATIVE_INFINITY));
      if (minimumDistance > bestDistance || minimumDistance === bestDistance && compareStableIdentifiers(candidate, best) < 0) {
        best = candidate;
        bestDistance = minimumDistance;
      }
    }
    starts[player] = [best];
    claimed.add(best);
  }
  return starts;
}
function coordinateAliasesFor(board) {
  const aliases = /* @__PURE__ */ new Map();
  for (const copy of board.atlas.pointCopies) {
    const key3 = copy.coordinate.join(",");
    const existing = aliases.get(key3);
    aliases.set(key3, existing && existing !== copy.canonicalVertexId ? null : copy.canonicalVertexId);
  }
  return aliases;
}
function compiledBoardWithStarts(board, starts) {
  const current = topologyStartingRoots(board);
  const same = Object.keys(current).length === Object.keys(starts).length && Object.entries(starts).every(([player, roots]) => stableStringify(current[player]) === stableStringify(roots));
  if (same) return board;
  const sourceByCanonical = new Map(board.canonicalVertices.map((vertex) => [vertex.id, vertex.sourceVertexIds[0]]));
  const definition = cloneJson3(board.definition);
  definition.startingVertices = Object.fromEntries(Object.entries(starts).map(([player, roots]) => {
    const sources = roots.map((canonicalVertexId) => {
      const source = sourceByCanonical.get(canonicalVertexId);
      if (!source) throw topologyError("UNKNOWN_START_VERTEX", canonicalVertexId);
      return source;
    });
    return [player, sources.length === 1 ? sources[0] : sources];
  }));
  const compiled = compileBoard(definition);
  if (!compiled.ok) {
    throw topologyError(
      "INVALID_STARTING_LAYOUT",
      compiled.errors.map((error) => error.code + "@" + error.location).join(", ")
    );
  }
  return compiled.value;
}
function cloneTerritory(territory) {
  return {
    polygon: null,
    area: territory.area,
    displayArea: territory.displayArea ?? territory.area,
    renderPoints: [...territory.renderPoints ?? []],
    ...territory.components ? { components: territory.components.map((component) => ({
      ...component,
      sampleIds: [...component.sampleIds]
    })) } : {}
  };
}
function cloneTopologyPaths(paths) {
  return Object.fromEntries(Object.entries(paths).map(([player, map]) => [
    player,
    [...map.values()].map(cloneConnection)
  ]));
}
function buildTopologyViewBoard(board) {
  const copyIdFor = /* @__PURE__ */ __name((sourceVertexId) => "copy:" + sourceVertexId, "copyIdFor");
  const pointCopies = board.atlas.pointCopies.map((copy) => ({
    id: copyIdFor(copy.sourceVertexId),
    canonicalVertexId: copy.canonicalVertexId,
    sourceVertexId: copy.sourceVertexId,
    coordinate: [...copy.coordinate]
  }));
  const edgeOccurrenceById = new Map(board.edgeOccurrences.map((occurrence) => [occurrence.id, occurrence]));
  const copiesForOccurrence = /* @__PURE__ */ __name((occurrence) => occurrence?.vertices?.map(copyIdFor) ?? [], "copiesForOccurrence");
  const realBoundarySegments = board.edgeClasses.filter((edgeClass) => edgeClass.occurrences.length === 1).map((edgeClass) => {
    const occurrence = edgeClass.occurrences[0];
    return {
      id: "boundary:" + edgeClass.id,
      copyIds: copiesForOccurrence(occurrence)
    };
  });
  const seamPairs = (board.definition.seamPairs ?? []).map((pair) => {
    const left = edgeOccurrenceById.get(pair.edgeOccurrenceA);
    const right = edgeOccurrenceById.get(pair.edgeOccurrenceB);
    return {
      id: pair.id,
      edgeOccurrenceA: pair.edgeOccurrenceA,
      edgeOccurrenceB: pair.edgeOccurrenceB,
      endpointMap: [...pair.endpointMap],
      copyIds: [...copiesForOccurrence(left), ...copiesForOccurrence(right)]
    };
  });
  return {
    pointCopies,
    realBoundarySegments,
    seamPairs,
    faces: board.definition.faces.map((face) => ({
      id: face.id,
      copyIds: face.vertices.map(copyIdFor),
      canonicalVertexIds: face.vertices.map((id) => board.rawVertexToCanonical[id])
    })),
    // Every occurrence is local to one chart and is safe to use as a guide
    // edge.  Paired occurrences remain visually separated at seams.
    displayEdges: board.edgeOccurrences.map((occurrence) => ({
      id: "guide:" + occurrence.id,
      copyIds: copiesForOccurrence(occurrence)
    }))
  };
}
function attachGameEnginePrototype(instance, basePrototype) {
  if (Object.getPrototypeOf(TopologyGameEngine.prototype) !== basePrototype) {
    Object.setPrototypeOf(TopologyGameEngine.prototype, basePrototype);
  }
  return instance;
}
function createTopologyGameEngine(options, runtime) {
  return new TopologyGameEngine(options, runtime);
}
var cloneJson3, cloneConnection, topologyError, sorted, TopologyGameEngine, TOPOLOGY_GAME_ENGINE_FACTORY2;
var init_TopologyGameEngine = __esm({
  "application-hard:TopologyGameEngine.js"() {
    init_BoardCompiler();
    init_BoardDefinition();
    init_BoardPaths();
    init_SurfaceTerritory();
    init_TopologyStartingPoints();
    init_TopologyStateCodec();
    cloneJson3 = /* @__PURE__ */ __name((value) => {
      if (typeof structuredClone === "function") return structuredClone(value);
      return JSON.parse(JSON.stringify(value));
    }, "cloneJson");
    cloneConnection = /* @__PURE__ */ __name((connection) => {
      const { owner: _owner, ...path } = connection;
      return {
        ...path,
        vertices: [...connection.vertices],
        edgeOccurrences: [...connection.edgeOccurrences],
        seamCrossings: (connection.seamCrossings ?? []).map((crossing) => ({ ...crossing }))
      };
    }, "cloneConnection");
    __name(sameStringArray, "sameStringArray");
    __name(sameSeamCrossings, "sameSeamCrossings");
    __name(samePhysicalPath, "samePhysicalPath");
    __name(isExactCompiledConnection, "isExactCompiledConnection");
    __name(assertExactCompiledConnection, "assertExactCompiledConnection");
    topologyError = /* @__PURE__ */ __name((code, detail = "") => {
      const error = new Error(detail ? code + ": " + detail : code);
      error.code = code;
      return error;
    }, "topologyError");
    sorted = /* @__PURE__ */ __name((values) => [...values].sort((left, right) => compareStableIdentifiers(String(left), String(right))), "sorted");
    __name(normalizeCompiledBoard, "normalizeCompiledBoard");
    __name(graphDistances, "graphDistances");
    __name(selectInitialPositions, "selectInitialPositions");
    __name(coordinateAliasesFor, "coordinateAliasesFor");
    __name(compiledBoardWithStarts, "compiledBoardWithStarts");
    __name(cloneTerritory, "cloneTerritory");
    __name(cloneTopologyPaths, "cloneTopologyPaths");
    __name(buildTopologyViewBoard, "buildTopologyViewBoard");
    __name(attachGameEnginePrototype, "attachGameEnginePrototype");
    TopologyGameEngine = class {
      static {
        __name(this, "TopologyGameEngine");
      }
      constructor(options, runtime) {
        attachGameEnginePrototype(this, runtime.basePrototype);
        this._runtime = runtime;
        this.compiledBoard = normalizeCompiledBoard(options);
        this.rulesVersion = options.rulesVersion ?? runtime.surfaceRulesVersion;
        if (this.rulesVersion !== runtime.surfaceRulesVersion) {
          throw topologyError("UNSUPPORTED_TOPOLOGY_RULES_VERSION", String(this.rulesVersion));
        }
        this.boardShape = "custom";
        this.isTopologyBoard = true;
        this.playerCount = options.playerCount ?? Math.max(
          2,
          Object.keys(this.compiledBoard.startingVertices ?? {}).length || 2
        );
        if (!Number.isInteger(this.playerCount) || this.playerCount < 2 || this.playerCount > 6) {
          throw topologyError("INVALID_PLAYER_COUNT");
        }
        this.activePlayers = runtime.playerOrder.slice(0, this.playerCount);
        this.startPlayer = this.activePlayers.includes(options.startPlayer) ? options.startPlayer : this.activePlayers[0];
        this.currentPlayer = this.startPlayer;
        const provisionalAliases = coordinateAliasesFor(this.compiledBoard);
        const selectedStarts = selectInitialPositions(
          this.compiledBoard,
          this.activePlayers,
          options.initialPositions,
          provisionalAliases
        );
        this.compiledBoard = compiledBoardWithStarts(this.compiledBoard, selectedStarts);
        this.boardDefinition = cloneJson3(this.compiledBoard.definition);
        this.boardHash = this.compiledBoard.boardHash;
        this.topologyContractVersion = this.compiledBoard.contractVersion;
        this._viewBoard = buildTopologyViewBoard(this.compiledBoard);
        this.gridSize = options.gridSize ?? Math.max(1, this.compiledBoard.sampleIds.length);
        this.boardVertices = this.compiledBoard.atlas.pointCopies.map((copy) => [...copy.coordinate]);
        this.validPositions = [...this.compiledBoard.sampleIds];
        this.positionKeys = new Set(this.validPositions);
        this._coordinateAliases = coordinateAliasesFor(this.compiledBoard);
        this.hasCustomInitialPositions = options.initialPositions != null;
        this.initialPositions = { ...this.compiledBoard.startingVertices };
        this.initialRoots = topologyStartingRoots(this.compiledBoard);
        this.grid = new Map(this.validPositions.map((id) => [id, runtime.pointState.EMPTY]));
        this.edges = Object.fromEntries(this.activePlayers.map((player) => [player, /* @__PURE__ */ new Set()]));
        this.topologyPaths = Object.fromEntries(this.activePlayers.map((player) => [player, /* @__PURE__ */ new Map()]));
        for (const player of this.activePlayers) {
          for (const root of this.initialRoots[player]) this._setState(root, this._getPlayerStates(player).node);
        }
        this.historyHashes = /* @__PURE__ */ new Set();
        this.resignedPlayers = /* @__PURE__ */ new Set();
        this.gameOver = false;
        this.consecutiveSkips = 0;
        this.passHistory = [];
        this.turnCount = 0;
        this.positionRevision = 0;
        this.deferTerritoryUpdates = Boolean(options.deferTerritoryUpdates);
        this._territoryStateRevision = 0;
        this._territoryCacheRevision = 0;
        this._isReplayingBatch = false;
        this.cachedTerritories = Object.fromEntries(this.activePlayers.map((player) => [player, {
          polygon: null,
          area: 0,
          displayArea: 0,
          renderPoints: []
        }]));
        this._updateTerritories();
        this.historyHashes.add(this._computeStateHash(this.currentPlayer));
      }
      _canonicalId(value) {
        if (typeof value === "string") {
          if (this.positionKeys.has(value)) return value;
          return this.compiledBoard.rawVertexToCanonical[value] ?? null;
        }
        if (Array.isArray(value) && value.length === 2 && value.every(Number.isInteger)) {
          return this._coordinateAliases.get(value.join(",")) ?? null;
        }
        return null;
      }
      _getPlayerStates(player) {
        return this._runtime.playerPointStates[player];
      }
      _getOpponents(player) {
        return this.activePlayers.filter((candidate) => candidate !== player);
      }
      _getInitialPosition(player) {
        return this.initialPositions[player];
      }
      _getInitialPositions(player) {
        return [...this.initialRoots[player]];
      }
      _getState(point) {
        const id = this._canonicalId(point);
        return id ? this.grid.get(id) : void 0;
      }
      _setState(point, state) {
        const id = this._canonicalId(point);
        if (!id) throw topologyError("INVALID_TOPOLOGY_POSITION");
        this.grid.set(id, state);
      }
      isValidPosition(point) {
        return this._canonicalId(point) != null;
      }
      _assertValidPosition(point) {
        if (!this.isValidPosition(point)) throw topologyError("INVALID_TOPOLOGY_POSITION");
      }
      getCurrentPlayer() {
        return this.currentPlayer;
      }
      getValidPositions() {
        return [...this.validPositions];
      }
      getStateAt(point) {
        const id = this._canonicalId(point);
        return id ? this.grid.get(id) : null;
      }
      getBoardMatrix() {
        return [];
      }
      getAdjacentPositions(point) {
        const id = this._canonicalId(point);
        return id ? [...this.compiledBoard.sampleAdjacency[id] ?? []] : [];
      }
      canConnect(pointA, pointB) {
        const start = this._canonicalId(pointA);
        const end = this._canonicalId(pointB);
        if (!start || !end || start === end) return false;
        return enumerateConnections(this.compiledBoard, { coverageByPlayer: { BLACK: [end] } }, start, "BLACK").some((connection) => connection.endVertexId === end);
      }
      getLinePoints(start, end) {
        const left = this._canonicalId(start);
        const right = this._canonicalId(end);
        if (!left || !right || left === right) return [];
        for (const player of this.activePlayers) {
          for (const connection of this.topologyPaths[player].values()) {
            if (connection.startVertexId === left && connection.endVertexId === right || connection.startVertexId === right && connection.endVertexId === left) {
              return [...connection.vertices];
            }
          }
        }
        const coverageByPlayer = { BLACK: [right] };
        const candidate = enumerateConnections(this.compiledBoard, { coverageByPlayer }, left, "BLACK").find((connection) => connection.endVertexId === right);
        return candidate ? [...candidate.vertices] : [];
      }
      canConnectWithBlocking(pointA, pointB, player = this.currentPlayer) {
        const start = this._canonicalId(pointA);
        const end = this._canonicalId(pointB);
        if (!start || !end || start === end) return false;
        const coverageByPlayer = this._coverageByPlayer(start);
        for (const owner of this.activePlayers) {
          coverageByPlayer[owner] = coverageByPlayer[owner].filter((id) => id !== end);
        }
        coverageByPlayer[player] ??= [];
        if (!coverageByPlayer[player].includes(end)) coverageByPlayer[player].push(end);
        return enumerateConnections(this.compiledBoard, { coverageByPlayer, nodesByPlayer: { [player]: [end] } }, start, player).some((connection) => connection.endVertexId === end);
      }
      _coverageByPlayer(excludedId = null) {
        const coverageByPlayer = {};
        for (const player of this.activePlayers) {
          const { node, line } = this._getPlayerStates(player);
          coverageByPlayer[player] = this.validPositions.filter((id) => id !== excludedId && (this.grid.get(id) === node || this.grid.get(id) === line));
        }
        return coverageByPlayer;
      }
      _getPlayerNodes(player) {
        const node = this._getPlayerStates(player).node;
        return this.validPositions.filter((id) => this.grid.get(id) === node);
      }
      _getPlayerLines(player) {
        const line = this._getPlayerStates(player).line;
        return this.validPositions.filter((id) => this.grid.get(id) === line);
      }
      _getEdges(player) {
        return this.edges[player];
      }
      _checkThreePointLimitation(vertexId, player) {
        const node = this._getPlayerStates(player).node;
        const adjacentNodes = this.getAdjacentPositions(vertexId).filter((id) => this.grid.get(id) === node);
        if (adjacentNodes.length >= 2) return false;
        return adjacentNodes.every((id) => !this.getAdjacentPositions(id).some((next) => next !== vertexId && this.grid.get(next) === node));
      }
      _isInProtectionZone(vertexId, player) {
        return this._getOpponents(player).some((opponent) => this.initialRoots[opponent].some((root) => this.getAdjacentPositions(root).includes(vertexId)));
      }
      _isEnemyState(state, player) {
        return this._getOpponents(player).some((opponent) => {
          const states = this._getPlayerStates(opponent);
          return state === states.node || state === states.line;
        });
      }
      _isEnemyLineState(state, player) {
        return this._getOpponents(player).some((opponent) => state === this._getPlayerStates(opponent).line);
      }
      _isOwnLineState(state, player) {
        return state === this._getPlayerStates(player).line;
      }
      _pathsIntactFor(player, connection) {
        const states = this._getPlayerStates(player);
        if (this.grid.get(connection.startVertexId) !== states.node || this.grid.get(connection.endVertexId) !== states.node) return false;
        return connection.vertices.every((vertexId) => !this._isEnemyState(this.grid.get(vertexId), player));
      }
      _rebuildTopology() {
        for (const player of this.activePlayers) {
          const line = this._getPlayerStates(player).line;
          for (const vertexId of this.validPositions) {
            if (this.grid.get(vertexId) === line) this.grid.set(vertexId, this._runtime.pointState.EMPTY);
          }
        }
        for (const player of this.activePlayers) {
          const paths = this.topologyPaths[player];
          for (const [pathId, connection] of [...paths]) {
            if (!this._pathsIntactFor(player, connection)) paths.delete(pathId);
          }
          this.edges[player] = new Set(sorted(paths.keys()));
          const line = this._getPlayerStates(player).line;
          const node = this._getPlayerStates(player).node;
          for (const connection of paths.values()) {
            for (const vertexId of connection.vertices) {
              if (this.grid.get(vertexId) === this._runtime.pointState.EMPTY) {
                this.grid.set(vertexId, line);
              } else if (this.grid.get(vertexId) === node) {
              }
            }
          }
        }
        let removed = false;
        for (const player of this.activePlayers) {
          const states = this._getPlayerStates(player);
          const roots = this.initialRoots[player];
          const reachable = new Set(roots);
          const queue = [...roots];
          const adjacency = /* @__PURE__ */ new Map();
          for (const connection of this.topologyPaths[player].values()) {
            if (!adjacency.has(connection.startVertexId)) adjacency.set(connection.startVertexId, []);
            if (!adjacency.has(connection.endVertexId)) adjacency.set(connection.endVertexId, []);
            adjacency.get(connection.startVertexId).push(connection.endVertexId);
            adjacency.get(connection.endVertexId).push(connection.startVertexId);
          }
          for (let index = 0; index < queue.length; index += 1) {
            for (const next of adjacency.get(queue[index]) ?? []) {
              if (!reachable.has(next)) {
                reachable.add(next);
                queue.push(next);
              }
            }
          }
          for (const vertexId of this.validPositions) {
            if (this.grid.get(vertexId) === states.node && !reachable.has(vertexId)) {
              this.grid.set(vertexId, this._runtime.pointState.EMPTY);
              removed = true;
            }
          }
        }
        if (removed) {
          for (const player of this.activePlayers) {
            for (const [pathId, connection] of [...this.topologyPaths[player]]) {
              if (!this._pathsIntactFor(player, connection)) this.topologyPaths[player].delete(pathId);
            }
          }
          this._rebuildTopology();
        }
      }
      _connectionsForPlacement(vertexId, player, originalState) {
        const position = {
          coverageByPlayer: this._coverageByPlayer(
            this._isOwnLineState(originalState, player) || this._isEnemyLineState(originalState, player) ? vertexId : null
          ),
          nodesByPlayer: Object.fromEntries(this.activePlayers.map((owner) => [owner, this._getPlayerNodes(owner)]))
        };
        return enumerateConnections(this.compiledBoard, position, vertexId, player);
      }
      _crawlTopology(player) {
        const nodes = this._getPlayerNodes(player);
        const nodeSet = new Set(nodes);
        for (const source of nodes) {
          const coverageByPlayer = this._coverageByPlayer(source);
          const candidates = enumerateConnections(this.compiledBoard, {
            coverageByPlayer,
            nodesByPlayer: { [player]: nodes.filter((id) => id !== source) }
          }, source, player);
          for (const path of candidates) {
            if (path.vertices.slice(1, -1).some((id) => nodeSet.has(id))) continue;
            if ([...this.topologyPaths[player].values()].some((existing) => this.boardDefinition.topology.movementStrategy === "simple-rays-v3" ? physicalPathKey(this.compiledBoard, existing) === physicalPathKey(this.compiledBoard, path) : samePhysicalPath(existing, path))) continue;
            this.topologyPaths[player].set(path.pathId, cloneConnection(path));
          }
          this._rebuildTopology();
        }
      }
      _addNode(point, player = this.currentPlayer) {
        const vertexId = this._canonicalId(point);
        if (!vertexId || this.resignedPlayers.has(player)) return false;
        const originalState = this.grid.get(vertexId);
        const empty = originalState === this._runtime.pointState.EMPTY;
        const ownLine = this._isOwnLineState(originalState, player);
        const enemyLine = this._isEnemyLineState(originalState, player);
        if (!empty && !ownLine && !enemyLine) return false;
        if (this._isInProtectionZone(vertexId, player)) return false;
        const cutsEnemyPath = enemyLine && this._getOpponents(player).some((opponent) => [...this.topologyPaths[opponent].values()].some((path) => path.vertices.slice(1, -1).includes(vertexId) && this._pathsIntactFor(opponent, path)));
        if (!cutsEnemyPath && !this._checkThreePointLimitation(vertexId, player)) return false;
        const connections = this._connectionsForPlacement(vertexId, player, originalState);
        if (!connections.length) return false;
        this.grid.set(vertexId, this._getPlayerStates(player).node);
        for (const connection of connections) {
          this.topologyPaths[player].set(connection.pathId, cloneConnection(connection));
        }
        this._rebuildTopology();
        if (cutsEnemyPath) {
          this._crawlTopology(player);
          for (const opponent of this._getOpponents(player)) this._crawlTopology(opponent);
        }
        return this.grid.get(vertexId) === this._getPlayerStates(player).node;
      }
      _computeStateHash(nextPlayer) {
        const occupied = this.validPositions.filter((id) => this.grid.get(id) !== this._runtime.pointState.EMPTY).map((id) => [id, this.grid.get(id)]);
        const paths = this.activePlayers.map((player) => [...this.topologyPaths[player].values()].sort((left, right) => compareStableIdentifiers(left.pathId, right.pathId)).map((connection) => [
          connection.pathId,
          connection.startVertexId,
          connection.endVertexId,
          connection.vertices
        ]));
        return JSON.stringify([
          "topology-state-v1",
          this.boardHash,
          nextPlayer,
          this.activePlayers.filter((player) => this.resignedPlayers.has(player)),
          occupied,
          paths
        ]);
      }
      _captureTopologyState() {
        return {
          grid: new Map(this.grid),
          edges: Object.fromEntries(this.activePlayers.map((player) => [player, new Set(this.edges[player])])),
          topologyPaths: Object.fromEntries(this.activePlayers.map((player) => [
            player,
            new Map([...this.topologyPaths[player]].map(([pathId, connection]) => [pathId, cloneConnection(connection)]))
          ])),
          historyHashes: new Set(this.historyHashes),
          currentPlayer: this.currentPlayer,
          gameOver: this.gameOver,
          consecutiveSkips: this.consecutiveSkips,
          passHistory: this.passHistory.map((entry) => ({ ...entry })),
          resignedPlayers: new Set(this.resignedPlayers),
          turnCount: this.turnCount,
          positionRevision: this.positionRevision,
          territoryStateRevision: this._territoryStateRevision,
          territoryCacheRevision: this._territoryCacheRevision,
          cachedTerritories: Object.fromEntries(this.activePlayers.map((player) => [player, cloneTerritory(this.cachedTerritories[player])]))
        };
      }
      _restoreTopologyState(state) {
        this.grid = new Map(state.grid);
        this.edges = Object.fromEntries(this.activePlayers.map((player) => [player, new Set(state.edges[player])]));
        this.topologyPaths = Object.fromEntries(this.activePlayers.map((player) => [
          player,
          new Map([...state.topologyPaths[player]].map(([pathId, connection]) => [pathId, cloneConnection(connection)]))
        ]));
        this.historyHashes = new Set(state.historyHashes);
        this.currentPlayer = state.currentPlayer;
        this.gameOver = state.gameOver;
        this.consecutiveSkips = state.consecutiveSkips;
        this.passHistory = state.passHistory.map((entry) => ({ ...entry }));
        this.resignedPlayers = new Set(state.resignedPlayers);
        this.turnCount = state.turnCount;
        this.positionRevision = state.positionRevision;
        this._territoryStateRevision = state.territoryStateRevision;
        this._territoryCacheRevision = state.territoryCacheRevision;
        this.cachedTerritories = Object.fromEntries(this.activePlayers.map((player) => [player, cloneTerritory(state.cachedTerritories[player])]));
      }
      _evaluateMove(point, player = this.currentPlayer) {
        if (this.resignedPlayers.has(player)) {
          return { legal: false, reason: "PLAYER_RESIGNED", state: null, isAttack: false };
        }
        const vertexId = this._canonicalId(point);
        if (!vertexId) return { legal: false, reason: "INVALID_MOVE", state: null, isAttack: false };
        const originalState = this.grid.get(vertexId);
        const state = this._captureTopologyState();
        try {
          if (!this._addNode(vertexId, player)) {
            return { legal: false, reason: "INVALID_MOVE", state: originalState, isAttack: false };
          }
          const stateHash = this._computeStateHash(this._getNextPlayer(player));
          if (this.historyHashes.has(stateHash)) {
            return {
              legal: false,
              reason: "SUPERKO_VIOLATION",
              state: originalState,
              isAttack: this._isEnemyLineState(originalState, player)
            };
          }
          return {
            legal: true,
            reason: null,
            state: originalState,
            isAttack: this._isEnemyLineState(originalState, player)
          };
        } finally {
          this._restoreTopologyState(state);
        }
      }
      getLegalMoves(player = this.currentPlayer) {
        const moves = [];
        for (const vertexId of this.validPositions) {
          const evaluation = this._evaluateMove(vertexId, player);
          if (evaluation.legal) moves.push({
            point: vertexId,
            vertexId,
            state: evaluation.state,
            isAttack: evaluation.isAttack
          });
        }
        return moves;
      }
      _hasValidMoves(player) {
        return this.getLegalMoves(player).length > 0;
      }
      _switchPlayer() {
        const currentIndex = this.activePlayers.indexOf(this.currentPlayer);
        for (let offset = 1; offset <= this.activePlayers.length; offset += 1) {
          const next = this.activePlayers[(currentIndex + offset) % this.activePlayers.length];
          if (!this.resignedPlayers.has(next)) {
            this.currentPlayer = next;
            return;
          }
        }
      }
      _getNextPlayer(player = this.currentPlayer) {
        const currentIndex = this.activePlayers.indexOf(player);
        for (let offset = 1; offset <= this.activePlayers.length; offset += 1) {
          const next = this.activePlayers[(currentIndex + offset) % this.activePlayers.length];
          if (!this.resignedPlayers.has(next)) return next;
        }
        return player;
      }
      _getRemainingPlayers() {
        return this.activePlayers.filter((player) => !this.resignedPlayers.has(player));
      }
      _checkResignationFinish() {
        const remaining = this._getRemainingPlayers();
        if (remaining.length <= 1) {
          this.gameOver = true;
          if (remaining.length === 1) this.currentPlayer = remaining[0];
          return true;
        }
        return false;
      }
      _checkAndAutoSkip() {
        if (this.gameOver || this._checkResignationFinish()) return;
        if (!this._hasValidMoves(this.currentPlayer)) {
          this.consecutiveSkips += 1;
          if (this.consecutiveSkips >= this._getRemainingPlayers().length) {
            this.gameOver = true;
          } else {
            this._switchPlayer();
            this._checkAndAutoSkip();
          }
        }
      }
      _topologyPositionForTerritory() {
        return { ownedSampleIdsByPlayer: this._coverageByPlayer() };
      }
      _updateTerritories() {
        const position = this._topologyPositionForTerritory();
        for (const player of this.activePlayers) {
          const result = computeTerritory(this.compiledBoard, position, player);
          this.cachedTerritories[player] = {
            polygon: null,
            area: result.area,
            displayArea: result.area,
            renderPoints: sorted(/* @__PURE__ */ new Set([...result.ownedSampleIds, ...result.enclosedSampleIds])),
            components: result.components.map((component) => ({
              ...component,
              sampleIds: [...component.sampleIds]
            }))
          };
        }
        this._territoryCacheRevision = this._territoryStateRevision;
      }
      _computeTerritory(player) {
        return cloneTerritory(this.cachedTerritories[player]);
      }
      hasPendingTerritoryUpdate() {
        return this._territoryCacheRevision !== this._territoryStateRevision;
      }
      getTerritoryStateRevision() {
        return this._territoryStateRevision;
      }
      applyTerritoryCache(territories, territoryStateRevision = this._territoryStateRevision) {
        if (territoryStateRevision !== this._territoryStateRevision || !territories) return false;
        const next = {};
        for (const player of this.activePlayers) {
          const territory = territories[player];
          if (!territory || !Number.isFinite(territory.area) || territory.area < 0 || !Array.isArray(territory.renderPoints) || territory.renderPoints.some((id) => !this.positionKeys.has(id))) return false;
          if (territory.components != null && (!Array.isArray(territory.components) || territory.components.some((component) => !Array.isArray(component.sampleIds) || component.sampleIds.some((id) => !this.positionKeys.has(id)) || typeof component.counted !== "boolean"))) return false;
          const components = territory.components ?? computeTerritory(this.compiledBoard, this._topologyPositionForTerritory(), player).components;
          next[player] = {
            polygon: null,
            area: territory.area,
            displayArea: Number.isFinite(territory.displayArea) ? territory.displayArea : territory.area,
            renderPoints: [...new Set(territory.renderPoints)],
            components: components.map((component) => ({ ...component, sampleIds: [...component.sampleIds] }))
          };
        }
        this.cachedTerritories = next;
        this._territoryCacheRevision = this._territoryStateRevision;
        return true;
      }
      getScoreboard() {
        return Object.fromEntries(this.activePlayers.map((player) => [player, cloneTerritory(this.cachedTerritories[player])]));
      }
      getWinner() {
        if (!this.gameOver) return null;
        if (this.hasPendingTerritoryUpdate()) this._updateTerritories();
        const candidates = this._getRemainingPlayers();
        const players = candidates.length ? candidates : this.activePlayers;
        let winner = null;
        let area = Number.NEGATIVE_INFINITY;
        let draw = false;
        for (const player of players) {
          const value = this.cachedTerritories[player].area;
          if (value > area) {
            area = value;
            winner = player;
            draw = false;
          } else if (value === area) {
            draw = true;
          }
        }
        return draw ? "DRAW" : winner;
      }
      _getSnapshotLegalMoves() {
        return this.getLegalMoves(this.currentPlayer).map((move) => ({ ...move }));
      }
      getSnapshot() {
        const scores = this.getScoreboard();
        const paths = cloneTopologyPaths(this.topologyPaths);
        return {
          gridSize: this.gridSize,
          playerCount: this.playerCount,
          boardShape: this.boardShape,
          isTopologyBoard: true,
          boardHash: this.boardHash,
          boardDefinition: cloneJson3(this.boardDefinition),
          topologyContractVersion: this.topologyContractVersion,
          topology: {
            canonicalVertices: this.compiledBoard.canonicalVertices.map((vertex) => ({
              id: vertex.id,
              sourceVertexIds: [...vertex.sourceVertexIds],
              atlasCoordinates: vertex.atlasCoordinates.map((coordinate) => [...coordinate])
            })),
            canonicalAdjacency: cloneJson3(this.compiledBoard.canonicalAdjacency),
            realBoundarySampleIds: [...this.compiledBoard.realBoundarySampleIds],
            pointCopies: this.compiledBoard.atlas.pointCopies.map((copy) => ({ ...copy, coordinate: [...copy.coordinate] })),
            startingRoots: cloneJson3(this.initialRoots),
            protectionZones: this.validPositions.map((canonicalVertexId) => ({
              canonicalVertexId,
              owners: this.activePlayers.filter((owner) => this.initialRoots[owner].some((root) => this.getAdjacentPositions(root).includes(canonicalVertexId)))
            })).filter((entry) => entry.owners.length),
            viewBoard: cloneJson3(this._viewBoard)
          },
          boardVertices: this.boardVertices.map((coordinate) => [...coordinate]),
          initialPositions: { ...this.initialPositions },
          initialRoots: cloneJson3(this.initialRoots),
          rulesVersion: this.rulesVersion,
          positionRevision: this.positionRevision,
          players: [...this.activePlayers],
          startPlayer: this.startPlayer,
          currentPlayer: this.currentPlayer,
          gameOver: this.gameOver,
          territoryPending: this.hasPendingTerritoryUpdate(),
          consecutiveSkips: this.consecutiveSkips,
          passHistory: this.passHistory.map((entry) => ({ ...entry })),
          resignedPlayers: [...this.resignedPlayers],
          turnCount: this.turnCount,
          boardMatrix: [],
          boardStates: Object.fromEntries(this.validPositions.map((id) => [id, this.grid.get(id)])),
          territories: scores,
          edges: Object.fromEntries(this.activePlayers.map((player) => [player, sorted(this.edges[player])])),
          topologyPaths: paths,
          winner: this.getWinner(),
          legalMoves: this._getSnapshotLegalMoves()
        };
      }
      _createActionResult(success, reason) {
        return { success, reason, snapshot: this._isReplayingBatch ? null : this.getSnapshot() };
      }
      playMove(point) {
        if (this.gameOver) return this._createActionResult(false, "GAME_OVER");
        const state = this._captureTopologyState();
        if (!this._addNode(point, this.currentPlayer)) return this._createActionResult(false, "INVALID_MOVE");
        const stateHash = this._computeStateHash(this._getNextPlayer(this.currentPlayer));
        if (this.historyHashes.has(stateHash)) {
          this._restoreTopologyState(state);
          return this._createActionResult(false, "SUPERKO_VIOLATION");
        }
        this.historyHashes.add(stateHash);
        this.turnCount += 1;
        this.positionRevision += 1;
        this._territoryStateRevision += 1;
        this.consecutiveSkips = 0;
        this._switchPlayer();
        this._checkAndAutoSkip();
        if (!this.deferTerritoryUpdates || this.gameOver) this._updateTerritories();
        return this._createActionResult(true, null);
      }
      skipTurn() {
        if (this.gameOver) return this._createActionResult(false, "GAME_OVER");
        this.passHistory.push({ player: this.currentPlayer, turn: this.turnCount + this.passHistory.length + 1 });
        this.consecutiveSkips += 1;
        this.positionRevision += 1;
        if (this.consecutiveSkips >= this._getRemainingPlayers().length) {
          this.gameOver = true;
        } else {
          this._switchPlayer();
          this._checkAndAutoSkip();
        }
        return this._createActionResult(true, null);
      }
      resignPlayer(player = this.currentPlayer) {
        if (this.gameOver) return this._createActionResult(false, "GAME_OVER");
        if (!this.activePlayers.includes(player)) return this._createActionResult(false, "UNKNOWN_PLAYER");
        if (this.resignedPlayers.has(player)) return this._createActionResult(false, "PLAYER_ALREADY_RESIGNED");
        this.resignedPlayers.add(player);
        this.turnCount += 1;
        this.positionRevision += 1;
        this.consecutiveSkips = 0;
        if (!this._checkResignationFinish() && this.currentPlayer === player) {
          this._switchPlayer();
          this._checkAndAutoSkip();
        }
        return this._createActionResult(true, null);
      }
      getTopologyRuleState() {
        const vertexStateById = {};
        for (const vertexId of this.validPositions) {
          const state = this.grid.get(vertexId);
          if (state === this._runtime.pointState.EMPTY) continue;
          const owner = this.activePlayers.find((player) => {
            const states2 = this._getPlayerStates(player);
            return state === states2.node || state === states2.line;
          });
          if (!owner) throw topologyError("UNKNOWN_VERTEX_OWNER", vertexId);
          const states = this._getPlayerStates(owner);
          vertexStateById[vertexId] = {
            owner,
            node: state === states.node,
            line: state === states.line
          };
        }
        const logicPaths = this.activePlayers.flatMap((player) => [...this.topologyPaths[player].values()].sort((left, right) => compareStableIdentifiers(left.pathId, right.pathId)).map((connection) => ({ ...cloneConnection(connection), owner: player })));
        return {
          stateVersion: TOPOLOGY_RULE_STATE_VERSION,
          rulesVersion: this.rulesVersion,
          currentPlayer: this.currentPlayer,
          startingVertices: topologyStartingState(this.compiledBoard),
          vertexStateById,
          logicPaths,
          historyHashes: sorted(this.historyHashes),
          superkoPolicy: "enforce",
          consecutivePasses: this.consecutiveSkips,
          passHistory: this.passHistory.map((entry) => ({ ...entry })),
          resignedPlayers: [...this.resignedPlayers],
          gameOver: this.gameOver,
          terminal: this.gameOver ? {
            winner: this.getWinner(),
            territories: Object.fromEntries(this.activePlayers.map((player) => [
              player,
              { area: this.cachedTerritories[player].area }
            ]))
          } : null,
          turnCount: this.turnCount,
          positionRevision: this.positionRevision
        };
      }
      encodeTopologyState(limits = {}) {
        return encodeTopologyState(this.compiledBoard, this.getTopologyRuleState(), limits);
      }
      _restoreTopologyRuleState(ruleState) {
        if (!ruleState || ruleState.rulesVersion !== this.rulesVersion) {
          throw topologyError("RULES_VERSION_MISMATCH");
        }
        if (stableStringify(ruleState.startingVertices) !== stableStringify(topologyStartingState(this.compiledBoard))) {
          throw topologyError("STARTING_VERTICES_MISMATCH");
        }
        if (ruleState.currentPlayer !== null && !this.activePlayers.includes(ruleState.currentPlayer)) {
          throw topologyError("UNKNOWN_CURRENT_PLAYER");
        }
        const candidateGrid = new Map(this.validPositions.map((id) => [id, this._runtime.pointState.EMPTY]));
        for (const [vertexId, state] of Object.entries(ruleState.vertexStateById)) {
          if (!this.positionKeys.has(vertexId) || !this.activePlayers.includes(state.owner)) {
            throw topologyError("INVALID_VERTEX_STATE", vertexId);
          }
          if (state.node && state.line) throw topologyError("UNSUPPORTED_COMBINED_VERTEX_STATE", vertexId);
          const playerStates = this._getPlayerStates(state.owner);
          candidateGrid.set(vertexId, state.node ? playerStates.node : playerStates.line);
        }
        for (const player of this.activePlayers) {
          if (this.initialRoots[player].some((root) => candidateGrid.get(root) !== this._getPlayerStates(player).node)) {
            throw topologyError("MISSING_START_NODE", player);
          }
        }
        const candidatePaths = Object.fromEntries(this.activePlayers.map((player) => [player, /* @__PURE__ */ new Map()]));
        for (const path of ruleState.logicPaths) {
          if (!this.activePlayers.includes(path.owner) || candidatePaths[path.owner].has(path.pathId)) {
            throw topologyError("INVALID_LOGIC_PATH", path.pathId);
          }
          assertExactCompiledConnection(this.compiledBoard, path);
          if (["simple-rays-v2", "simple-rays-v3"].includes(this.compiledBoard.definition.topology.movementStrategy)) {
            if (new Set(path.vertices).size !== path.vertices.length) throw topologyError("INVALID_LOGIC_PATH", "Self-crossing path");
            const inner = new Set(path.vertices.slice(1, -1));
            for (const other of candidatePaths[path.owner].values()) {
              if (other.vertices.slice(1, -1).some((id) => inner.has(id))) {
                throw topologyError("INVALID_LOGIC_PATH", "Crossing path interiors");
              }
            }
          }
          candidatePaths[path.owner].set(path.pathId, cloneConnection(path));
        }
        const before = this._captureTopologyState();
        try {
          this.grid = candidateGrid;
          this.topologyPaths = candidatePaths;
          this.edges = Object.fromEntries(this.activePlayers.map((player) => [player, /* @__PURE__ */ new Set()]));
          this._rebuildTopology();
          const restored = this.getTopologyRuleState();
          if (stableStringify(restored.vertexStateById) !== stableStringify(ruleState.vertexStateById)) {
            throw topologyError("INCONSISTENT_TOPOLOGY_STATE", "Path coverage does not reproduce vertex state.");
          }
          this.historyHashes = new Set(ruleState.historyHashes);
          this.currentPlayer = ruleState.currentPlayer ?? this.startPlayer;
          this.consecutiveSkips = ruleState.consecutivePasses;
          this.passHistory = ruleState.passHistory.map((entry) => ({ ...entry }));
          this.resignedPlayers = new Set(ruleState.resignedPlayers);
          this.gameOver = ruleState.gameOver;
          this.turnCount = ruleState.turnCount;
          this.positionRevision = ruleState.positionRevision;
          this._territoryStateRevision = this.positionRevision;
          this._territoryCacheRevision = this.positionRevision;
          this._updateTerritories();
        } catch (error) {
          this._restoreTopologyState(before);
          throw error;
        }
      }
      restoreTopologyState(json, limits = {}) {
        const decoded = decodeTopologyState(json, limits);
        if (decoded.boardHash !== this.boardHash) {
          throw topologyError("BOARD_HASH_MISMATCH");
        }
        this._restoreTopologyRuleState(decoded.ruleState);
        return true;
      }
      replayBatch(callback) {
        if (typeof callback !== "function" || Object.prototype.toString.call(callback) === "[object AsyncFunction]") {
          throw topologyError("INVALID_REPLAY_CALLBACK");
        }
        const transaction = createTopologyGameEngine({
          compiledBoard: this.compiledBoard,
          playerCount: this.playerCount,
          startPlayer: this.startPlayer,
          initialPositions: this.initialRoots,
          rulesVersion: this.rulesVersion,
          deferTerritoryUpdates: this.deferTerritoryUpdates
        }, this._runtime);
        transaction._restoreTopologyState(this._captureTopologyState());
        transaction._isReplayingBatch = true;
        let result;
        try {
          result = callback(transaction);
          if (result && typeof result.then === "function") throw topologyError("INVALID_REPLAY_CALLBACK");
        } finally {
          transaction._isReplayingBatch = false;
        }
        if (!result?.success) {
          return { ...result ?? {}, success: false, reason: result?.reason ?? "REPLAY_FAILED", snapshot: null };
        }
        transaction._updateTerritories();
        const snapshot = transaction.getSnapshot();
        this._restoreTopologyState(transaction._captureTopologyState());
        return { ...result, snapshot };
      }
    };
    __name(createTopologyGameEngine, "createTopologyGameEngine");
    TOPOLOGY_GAME_ENGINE_FACTORY2 = Symbol.for("lifeline.topology-game-engine-factory.v1");
    Object.defineProperty(globalThis, TOPOLOGY_GAME_ENGINE_FACTORY2, {
      value: createTopologyGameEngine,
      configurable: true,
      writable: true
    });
  }
});

// application-hard:AIStateProtocol.js
function serializeEngineState(engine) {
  if (!engine) {
    throw new Error("serializeEngineState requires a GameEngine instance.");
  }
  if (engine.isTopologyBoard) {
    return {
      isTopologyBoard: true,
      boardHash: engine.boardHash,
      topologyState: engine.encodeTopologyState(),
      playerCount: engine.playerCount,
      rulesVersion: engine.rulesVersion,
      positionRevision: engine.positionRevision,
      currentPlayer: engine.currentPlayer
    };
  }
  return {
    gridSize: engine.gridSize,
    playerCount: engine.playerCount,
    boardShape: engine.boardShape,
    startPlayer: engine.startPlayer,
    ...engine.hasCustomInitialPositions ? { initialPositions: cloneValue2(engine.initialPositions) } : {},
    initialRoots: cloneValue2(engine.initialRoots),
    roots: Object.fromEntries(engine.activePlayers.map((player) => [player, engine.getRoots(player)])),
    rootMode: engine.rootMode,
    rootRulesVersion: engine.rootRulesVersion,
    rootActionsRemaining: cloneValue2(engine.rootActionsRemaining),
    rootStateIdentity: getRootStateIdentity(engine),
    rulesVersion: engine.rulesVersion,
    ...engine.protectionRule !== "symmetric-v1" ? { protectionRule: engine.protectionRule } : {},
    positionRevision: engine.positionRevision,
    activePlayers: [...engine.activePlayers],
    gridEntries: [...engine.grid.entries()],
    edges: Object.fromEntries(engine.activePlayers.map((player) => [player, [...engine.edges[player] ?? []]])),
    edgesBlack: [...engine.edges.BLACK ?? []],
    edgesWhite: [...engine.edges.WHITE ?? []],
    edgesPurple: [...engine.edges.PURPLE ?? []],
    historyHashes: [...engine.historyHashes],
    consecutiveSkips: engine.consecutiveSkips,
    resignedPlayers: [...engine.resignedPlayers],
    currentPlayer: engine.currentPlayer,
    gameOver: engine.gameOver,
    turnCount: engine.turnCount
  };
}
function getRootStateIdentity(engine) {
  if (!engine || engine.isTopologyBoard) return null;
  return JSON.stringify({
    rootRulesVersion: engine.rootRulesVersion,
    rootMode: engine.rootMode,
    roots: Object.fromEntries((engine.activePlayers ?? []).map((player) => [
      player,
      (engine.getRoots?.(player) ?? engine.roots?.[player] ?? []).map((point) => point.join(",")).sort()
    ])),
    remaining: Object.fromEntries((engine.activePlayers ?? []).map((player) => [
      player,
      {
        relocate: engine.rootActionsRemaining?.[player]?.relocate ?? 0,
        add: engine.rootActionsRemaining?.[player]?.add ?? 0
      }
    ]))
  });
}
function restoreEngineRootState(engine, serializedState) {
  engine.roots = Object.fromEntries(engine.activePlayers.map((player) => [
    player,
    cloneValue2(serializedState.roots?.[player] ?? engine.initialRoots[player])
  ]));
  engine.rootActionsRemaining = cloneValue2(serializedState.rootActionsRemaining ?? engine.rootActionsRemaining);
  return engine;
}
function deserializeEngineEdges(serializedState, players) {
  const legacy = {
    BLACK: serializedState.edgesBlack,
    WHITE: serializedState.edgesWhite,
    PURPLE: serializedState.edgesPurple
  };
  return Object.fromEntries(players.map((player) => [
    player,
    new Set(serializedState.edges?.[player] ?? legacy[player] ?? [])
  ]));
}
function isWorkerResultCurrent(engine, message) {
  return Boolean(
    engine && message && engine.positionRevision === message.positionRevision && engine.rulesVersion === message.rulesVersion && (engine.protectionRule ?? "symmetric-v1") === (message.protectionRule ?? "symmetric-v1") && engine.currentPlayer === message.currentPlayer && (!engine.isTopologyBoard || engine.boardHash === message.boardHash) && ((engine.rootRulesVersion == null || engine.rootRulesVersion === "root-v1") && message.rootStateIdentity == null || getRootStateIdentity(engine) === message.rootStateIdentity)
  );
}
function captureWorkerRequest(engine, requestId) {
  if (!engine) {
    throw new Error("captureWorkerRequest requires a GameEngine instance.");
  }
  return Object.freeze({
    requestId,
    engine,
    positionRevision: engine.positionRevision,
    rulesVersion: engine.rulesVersion,
    protectionRule: engine.protectionRule ?? "symmetric-v1",
    currentPlayer: engine.currentPlayer,
    historySignature: workerHistorySignature(engine),
    ...engine.isTopologyBoard ? { boardHash: engine.boardHash } : {},
    rootStateIdentity: getRootStateIdentity(engine)
  });
}
function isWorkerResultForRequest(engine, request, message) {
  return Boolean(
    request && message && message.requestId === request.requestId && engine === request.engine && engine.positionRevision === request.positionRevision && engine.rulesVersion === request.rulesVersion && (engine.protectionRule ?? "symmetric-v1") === (request.protectionRule ?? "symmetric-v1") && engine.currentPlayer === request.currentPlayer && workerHistorySignature(engine) === request.historySignature && getRootStateIdentity(engine) === request.rootStateIdentity && message.positionRevision === request.positionRevision && message.rulesVersion === request.rulesVersion && (message.protectionRule ?? "symmetric-v1") === (request.protectionRule ?? "symmetric-v1") && message.currentPlayer === request.currentPlayer && (!request.boardHash || engine.isTopologyBoard && engine.boardHash === request.boardHash && message.boardHash === request.boardHash) && ((engine.rootRulesVersion == null || engine.rootRulesVersion === "root-v1") && message.rootStateIdentity == null || message.rootStateIdentity === request.rootStateIdentity)
  );
}
var cloneValue2, workerHistorySignature;
var init_AIStateProtocol = __esm({
  "application-hard:AIStateProtocol.js"() {
    cloneValue2 = /* @__PURE__ */ __name((value) => JSON.parse(JSON.stringify(value)), "cloneValue");
    __name(serializeEngineState, "serializeEngineState");
    __name(getRootStateIdentity, "getRootStateIdentity");
    __name(restoreEngineRootState, "restoreEngineRootState");
    __name(deserializeEngineEdges, "deserializeEngineEdges");
    __name(isWorkerResultCurrent, "isWorkerResultCurrent");
    workerHistorySignature = /* @__PURE__ */ __name((engine) => JSON.stringify([...engine?.historyHashes ?? []].sort()), "workerHistorySignature");
    __name(captureWorkerRequest, "captureWorkerRequest");
    __name(isWorkerResultForRequest, "isWorkerResultForRequest");
  }
});

// application-hard:RootTacticalOverlay.js
function applyRootTacticalOverlay(engine, player, ranked, { deadline = clock() + 200 } = {}) {
  const original = [...ranked];
  const receipt = { status: "preserved", complete: false, candidates: 0, scope: "next-actor-cut-and-pass" };
  if (engine.isTopologyBoard || original.length < 2 || original[0]?.point == null || original[1]?.point == null || engine.gameOver || engine.currentPlayer !== player) {
    return { moves: original, receipt: { ...receipt, status: "not-applicable" } };
  }
  const originalState = engine._captureReplayState();
  const originalBatch = engine._isReplayingBatch, originalDefer = engine.deferTerritoryUpdates;
  const check2 = /* @__PURE__ */ __name(() => {
    if (clock() >= deadline) throw LIMIT2;
  }, "check");
  const examine = /* @__PURE__ */ __name((move) => {
    check2();
    engine._restoreReplayState(originalState);
    if (!engine.playMove(move.point).success) throw new Error("Policy produced an illegal candidate");
    check2();
    if (engine.gameOver || engine.currentPlayer === player || engine.consecutiveSkips > 0) throw LIMIT2;
    const actor = engine.currentPlayer;
    const stable = computeRootStability(engine, player).nodeCount;
    const ownNodes = engine._getPlayerNodes(player).length;
    const enemyNodes = engine.activePlayers.filter((other) => other !== player && !engine.resignedPlayers.has(other)).reduce((sum, other) => sum + engine._getPlayerNodes(other).length, 0);
    const encirclement = computeEncirclementFeatures(engine, player, check2);
    const afterCandidate = engine._captureReplayState();
    let worstNodes = ownNodes, replies = 0;
    for (const point of engine._getPlayerLines(player)) {
      check2();
      engine._restoreReplayState(afterCandidate);
      if (!engine._evaluateMove(point, actor).legal) continue;
      engine._restoreReplayState(afterCandidate);
      if (!engine.playMove(point).success) throw new Error("Validated tactical reply failed");
      check2();
      worstNodes = Math.min(worstNodes, engine._getPlayerNodes(player).length);
      replies += 1;
    }
    engine._restoreReplayState(afterCandidate);
    check2();
    if (!engine.skipTurn().success) throw new Error("Tactical PASS failed");
    check2();
    if (engine.gameOver) throw LIMIT2;
    worstNodes = Math.min(worstNodes, engine._getPlayerNodes(player).length);
    return { stable, ownNodes, enemyNodes, worstNodes, encirclement, replies: replies + 1 };
  }, "examine");
  try {
    engine._isReplayingBatch = true;
    engine.deferTerritoryUpdates = true;
    const first = examine(original[0]);
    const second = examine(original[1]);
    receipt.complete = true;
    receipt.candidates = 2;
    receipt.first = first;
    receipt.second = second;
    if (second.ownNodes >= first.ownNodes && second.enemyNodes <= first.enemyNodes && second.worstNodes >= first.worstNodes && second.encirclement.pressure >= first.encirclement.pressure && (second.worstNodes > first.worstNodes || second.stable > first.stable || second.encirclement.pressure > first.encirclement.pressure)) {
      [original[0], original[1]] = [original[1], original[0]];
      receipt.status = "selected-verified-improvement";
    } else receipt.status = "preserved-no-dominance";
  } catch (error) {
    receipt.status = error === LIMIT2 ? "preserved-budget-or-unsupported-position" : "preserved-probe-error";
  } finally {
    engine._restoreReplayState(originalState);
    engine._isReplayingBatch = originalBatch;
    engine.deferTerritoryUpdates = originalDefer;
  }
  return { moves: original, receipt };
}
var LIMIT2, clock;
var init_RootTacticalOverlay = __esm({
  "application-hard:RootTacticalOverlay.js"() {
    init_RootStability();
    init_EncirclementFeatures();
    LIMIT2 = Symbol("root-tactical-budget");
    clock = /* @__PURE__ */ __name(() => globalThis.performance?.now?.() ?? Date.now(), "clock");
    __name(applyRootTacticalOverlay, "applyRootTacticalOverlay");
  }
});

// application-hard:AIWorker.js
var AIWorker_exports = {};
function canonicalTerminalWinningPass(engine, player, now2 = () => performance.now()) {
  try {
    const started = now2();
    if (!Number.isFinite(started)) return null;
    const deadline = started + TERMINAL_WINNING_PASS_WINDOW_MS;
    if (engine.gameOver || engine.currentPlayer !== player) return null;
    const remaining = engine.activePlayers.filter((candidate) => !engine.resignedPlayers.has(candidate));
    if (remaining.length < 2 || engine.consecutiveSkips !== remaining.length - 1) return null;
    const isolated = new GameEngine({
      gridSize: engine.gridSize,
      playerCount: engine.playerCount,
      boardShape: engine.boardShape,
      startPlayer: engine.startPlayer,
      initialPositions: engine.initialPositions,
      initialRoots: engine.initialRoots,
      rootMode: engine.rootMode,
      rootRulesVersion: engine.rootRulesVersion,
      rulesVersion: engine.rulesVersion,
      protectionRule: engine.protectionRule,
      deferTerritoryUpdates: true
    });
    restoreState2(isolated, saveState2(engine));
    isolated._isReplayingBatch = true;
    const hasNonPassAction = isolated.rootMode === "classic" ? isolated._hasValidMoves(player) : isolated._hasAnyNonPassAction(player);
    if (!hasNonPassAction) return null;
    if (now2() >= deadline) return null;
    const result = isolated.skipTurn();
    if (!result.success || !isolated.gameOver) return null;
    if (now2() >= deadline) return null;
    GameEngine.prototype._updateTerritories.call(isolated);
    if (now2() >= deadline) return null;
    const bestArea = Math.max(...remaining.map((candidate) => isolated.cachedTerritories[candidate].area));
    const winners = remaining.filter((candidate) => isolated.cachedTerritories[candidate].area === bestArea);
    const winner = isolated.getWinner();
    if (now2() >= deadline || winners.length !== 1 || winners[0] !== player || winner !== player) return null;
    return { point: null, type: "pass", score: 1e6 };
  } catch (_) {
    return null;
  }
}
var TERMINAL_WINNING_PASS_WINDOW_MS;
var init_AIWorker = __esm({
  "application-hard:AIWorker.js"() {
    init_GameEngine();
    init_AIStateProtocol();
    init_AIEngine();
    init_RootTacticalOverlay();
    TERMINAL_WINNING_PASS_WINDOW_MS = 60;
    __name(canonicalTerminalWinningPass, "canonicalTerminalWinningPass");
    self.onmessage = async (event) => {
      if (event.data?.type === "WARMUP") {
        try {
          const { warmMultiplayerResources: warmMultiplayerResources2 } = await Promise.resolve().then(() => (init_MultiplayerAIWarmup(), MultiplayerAIWarmup_exports));
          await warmMultiplayerResources2(event.data);
        } catch (_) {
          self.postMessage({ type: "WARMUP_FAILED" });
        }
        return;
      }
      if (event.data?.type !== "COMPUTE") {
        return;
      }
      const requestStarted = globalThis.performance?.now?.() ?? Date.now();
      try {
        const {
          serializedState,
          aiPlayer,
          depth = 3,
          topN = 5,
          strategy = "minimax",
          requestId = null
        } = event.data;
        if (serializedState?.isTopologyBoard) {
          const [topologyStateModule, topologyAiModule, topologySearchModule] = await Promise.all([
            Promise.resolve().then(() => (init_TopologyStateCodec(), TopologyStateCodec_exports)),
            Promise.resolve().then(() => (init_TopologyAIAdapter(), TopologyAIAdapter_exports)),
            Promise.resolve().then(() => (init_TopologySearchAI(), TopologySearchAI_exports)),
            Promise.resolve().then(() => (init_TopologyGameEngine(), TopologyGameEngine_exports))
          ]);
          const { decodeTopologyState: decodeTopologyState2 } = topologyStateModule;
          const {
            TOPOLOGY_AI_ADAPTER_VERSION: TOPOLOGY_AI_ADAPTER_VERSION2,
            TOPOLOGY_AI_ROUTE: TOPOLOGY_AI_ROUTE2,
            TOPOLOGY_AI_PASS: TOPOLOGY_AI_PASS2,
            buildTopologyAIState: buildTopologyAIState2,
            validateTopologyAIRequest: validateTopologyAIRequest2
          } = topologyAiModule;
          if (strategy !== "topology-generic") {
            throw new Error("Topology boards require the explicit topology-generic AI route.");
          }
          const decoded = decodeTopologyState2(serializedState.topologyState);
          if (decoded.boardHash !== serializedState.boardHash) {
            throw new Error("Topology AI state boardHash does not match its encoded board.");
          }
          const engine2 = new GameEngine({
            compiledBoard: decoded.board,
            playerCount: Object.keys(decoded.ruleState.startingVertices).length,
            startPlayer: decoded.ruleState.currentPlayer ?? void 0,
            rulesVersion: decoded.ruleState.rulesVersion,
            deferTerritoryUpdates: false
          });
          engine2.restoreTopologyState(serializedState.topologyState);
          if (engine2.currentPlayer !== aiPlayer) {
            throw new Error("Topology AI request player is not the current player.");
          }
          const coverageByPlayer = engine2._coverageByPlayer();
          const logicalPathsByPlayer = Object.fromEntries(engine2.activePlayers.map((player) => [
            player,
            [...engine2.topologyPaths[player].values()].map((path) => ({ ...path }))
          ]));
          const state = buildTopologyAIState2(engine2.compiledBoard, {
            rulesVersion: engine2.rulesVersion,
            positionRevision: engine2.positionRevision,
            currentPlayer: engine2.currentPlayer,
            // Search generates rule-checked moves under the same absolute budget;
            // do not perform a separate, unbounded duplicate legality scan here.
            legalMoveIds: [TOPOLOGY_AI_PASS2],
            coverageByPlayer,
            logicalPathsByPlayer,
            historyHashes: [...engine2.historyHashes]
          });
          const request = {
            contractVersion: TOPOLOGY_AI_ADAPTER_VERSION2,
            boardHash: engine2.boardHash,
            rulesVersion: engine2.rulesVersion,
            positionRevision: engine2.positionRevision,
            currentPlayer: engine2.currentPlayer,
            modelRoute: TOPOLOGY_AI_ROUTE2,
            legalMoveIds: state.legalMoveIds,
            state
          };
          const validation = validateTopologyAIRequest2(engine2.compiledBoard, request, {
            rulesVersion: engine2.rulesVersion,
            positionRevision: engine2.positionRevision,
            currentPlayer: engine2.currentPlayer
          });
          if (!validation.ok) throw new Error("Invalid topology AI request: " + validation.errors.map((error) => error.code).join(","));
          const topologyTimeLimitMs = Math.max(25, Math.min(5e3, Number(event.data.timeLimitMs) || 3e3));
          const { moves: moves2, searchInfo } = topologySearchModule.searchTopologyMoves(engine2, {
            aiPlayer,
            maxDepth: event.data.depth ?? Math.max(3, 2 * engine2._getRemainingPlayers().length),
            topN,
            timeLimitMs: topologyTimeLimitMs,
            deadline: requestStarted + topologyTimeLimitMs
          });
          self.postMessage({
            type: "RESULT",
            requestId,
            strategy,
            boardHash: engine2.boardHash,
            positionRevision: engine2.positionRevision,
            rulesVersion: engine2.rulesVersion,
            currentPlayer: engine2.currentPlayer,
            moves: moves2,
            searchInfo,
            modelInfo: {
              id: TOPOLOGY_AI_ROUTE2,
              route: TOPOLOGY_AI_ROUTE2,
              strengthVerified: false
            }
          });
          return;
        }
        const engine = new GameEngine({
          gridSize: serializedState.gridSize,
          playerCount: serializedState.playerCount,
          boardShape: serializedState.boardShape,
          startPlayer: serializedState.startPlayer,
          initialPositions: serializedState.initialPositions,
          initialRoots: serializedState.initialRoots,
          rootMode: serializedState.rootMode,
          rootRulesVersion: serializedState.rootRulesVersion,
          rulesVersion: serializedState.rulesVersion,
          protectionRule: serializedState.protectionRule
        });
        restoreEngineRootState(engine, serializedState);
        restoreState2(engine, {
          grid: new Map(serializedState.gridEntries),
          edges: deserializeEngineEdges(serializedState, engine.activePlayers),
          historyHashes: new Set(serializedState.historyHashes),
          roots: serializedState.roots,
          rootActionsRemaining: serializedState.rootActionsRemaining,
          consecutiveSkips: serializedState.consecutiveSkips,
          resignedPlayers: new Set(serializedState.resignedPlayers ?? []),
          currentPlayer: serializedState.currentPlayer,
          gameOver: serializedState.gameOver,
          turnCount: serializedState.turnCount,
          positionRevision: serializedState.positionRevision ?? 0,
          // The compact worker protocol intentionally omits the display territory
          // cache.  Mark it stale so a terminal leaf reached only by PASS still
          // computes the exact native area instead of reading the fresh engine's
          // initial 0/1-point cache.
          territoryStateRevision: serializedState.territoryStateRevision ?? serializedState.positionRevision ?? 0,
          territoryCacheRevision: serializedState.territoryCacheRevision ?? -1,
          cachedTerritories: engine.cachedTerritories
        });
        const nativeShape = engine.playerCount >= 4 ? "hexagon" : "triangle";
        if (engine.boardShape !== nativeShape && !["greedy", "minimax", "mcts", "multiplayer"].includes(strategy)) {
          throw new Error("\u5F53\u524D\u6A21\u578B\u4E0D\u652F\u6301\u6240\u9009\u68CB\u76D8\u5F62\u72B6\uFF0C\u8BF7\u9009\u62E9\u901A\u7528 AI\u3002");
        }
        if (engine.rootMode !== "classic" && !["greedy", "minimax", "mcts"].includes(strategy)) {
          throw new Error("\u65B0\u8D77\u70B9\u73A9\u6CD5\u4EC5\u652F\u6301\u5DF2\u9002\u914D\u7684\u901A\u7528 AI\uFF1B\u65E7\u6A21\u578B\u548C\u591A\u4EBA\u4F18\u5316\u8DEF\u5F84\u5DF2\u7981\u7528\u3002");
        }
        let ai = null;
        let modelInfo = null;
        if (strategy === "greedy") {
          ai = new GreedyAI2();
          modelInfo = { strategy: "greedy", runtime_policy: "generic-rule-greedy", trained_model: false };
        } else if (strategy === "minimax") {
          ai = new MinimaxAI2(depth);
        } else if (strategy === "mcts") {
          ai = new MCTSAI2({
            simulations: event.data?.simulations ?? 64,
            rolloutDepth: event.data?.rolloutDepth ?? 40,
            seed: event.data?.seed ?? 521288629
          });
        } else if (strategy === "neural-puct") {
          if (engine.playerCount !== 2) throw new Error("\u6A21\u578B\u4E0D\u652F\u6301\u6B64\u68CB\u76D8/\u89C4\u5219/\u73A9\u5BB6\u6570\u3002");
          const { loadResearchModel, NeuralPUCTAI, supportsResearchInference } = await import("./ResearchAI.js?v=20261029-unified-r1");
          const model = await loadResearchModel(event.data?.modelId);
          if (!supportsResearchInference(model.spec, engine)) throw new Error("\u6A21\u578B\u4E0D\u652F\u6301\u6B64\u68CB\u76D8/\u89C4\u5219/\u73A9\u5BB6\u6570\u3002");
          modelInfo = {
            id: model.spec.id,
            seed: model.spec.seed ?? 20260825,
            trainedBoardSizes: model.spec.trained_board_sizes,
            evidenceTier: model.spec.evidence_tier ?? "legacy",
            compatibility: model.spec.compatibility ?? "territory-v2 trial",
            checkpoint: model.spec.checkpoint,
            simulations: event.data?.simulations ?? 16,
            cPuct: event.data?.cPuct ?? 1.5
          };
          ai = new NeuralPUCTAI(model, {
            simulations: event.data?.simulations ?? 16,
            cPuct: event.data?.cPuct ?? 1.5
          });
        } else if (strategy === "model-free") {
          if (engine.playerCount !== 2) throw new Error("model-free \u7F51\u9875\u6A21\u578B\u4EC5\u652F\u6301\u53CC\u4EBA\u5C40\u9762\u3002");
          const { loadModelFreeModel, ModelFreeAI } = await import("./ModelFreeAI.js?v=20261029-unified-r1");
          const model = await loadModelFreeModel(event.data?.modelId);
          ai = new ModelFreeAI(model);
        } else if (strategy === "multiplayer") {
          const { loadMultiplayerRuntime: loadMultiplayerRuntime2 } = await Promise.resolve().then(() => (init_MultiplayerHardWorkerRuntime(), MultiplayerHardWorkerRuntime_exports));
          const runtime = await loadMultiplayerRuntime2(event.data?.modelId, engine);
          ai = runtime.ai;
          modelInfo = runtime.modelInfo;
          if (modelInfo?.id !== event.data?.modelId) throw new Error("\u591A\u4EBA AI \u6A21\u578B\u8EAB\u4EFD\u6821\u9A8C\u5931\u8D25\u3002");
        } else if (strategy === "three-player") {
          const { loadThreePlayerRuntime: loadThreePlayerRuntime2 } = await Promise.resolve().then(() => (init_ThreePlayerRuntime(), ThreePlayerRuntime_exports));
          const runtime = await loadThreePlayerRuntime2(event.data?.modelId, engine);
          ai = runtime.ai;
          modelInfo = runtime.modelInfo;
        } else if (strategy === "hex-player") {
          const { loadHexPlayerRuntime } = await import("./HexPlayerRuntime.js?v=20261029-unified-r1");
          const runtime = await loadHexPlayerRuntime(event.data?.modelId, engine);
          ai = runtime.ai;
          modelInfo = runtime.modelInfo;
        }
        if (!ai) {
          throw new Error(`Unsupported AI strategy: ${strategy}`);
        }
        const exactWinningPass = topN > 0 ? canonicalTerminalWinningPass(engine, aiPlayer) : null;
        const decisionStarted = globalThis.performance?.now?.() ?? Date.now();
        if (strategy === "multiplayer" || event.data.enableProgress === true) {
          self.postMessage({
            type: "READY",
            requestId,
            strategy,
            positionRevision: serializedState.positionRevision ?? 0,
            rulesVersion: serializedState.rulesVersion,
            protectionRule: serializedState.protectionRule,
            currentPlayer: serializedState.currentPlayer,
            rootStateIdentity: serializedState.rootStateIdentity,
            modelInfo
          });
        }
        const decisionDeadline = decisionStarted + Math.max(25, Math.min(5e3, Number(event.data.timeLimitMs) || 3e3));
        let bestProgress = null;
        let lastProgressAt = -Infinity, lastProgressReason = null;
        const publishProgress = /* @__PURE__ */ __name((move, reason) => {
          if (event.data.enableProgress !== true || !Array.isArray(move?.point) || move.point.length !== 2 || !move.point.every(Number.isInteger)) return;
          const progressAt = globalThis.performance?.now?.() ?? Date.now();
          if (reason === lastProgressReason && progressAt - lastProgressAt < 150) return;
          bestProgress = { ...move, type: "move", point: [...move.point] };
          lastProgressAt = progressAt;
          lastProgressReason = reason;
          self.postMessage({
            type: "PROGRESS",
            requestId,
            strategy,
            positionRevision: serializedState.positionRevision ?? 0,
            rulesVersion: serializedState.rulesVersion,
            protectionRule: serializedState.protectionRule,
            currentPlayer: serializedState.currentPlayer,
            modelInfo,
            moves: [bestProgress],
            searchInfo: { complete: false, fallback: true, fallbackReason: reason }
          });
        }, "publishProgress");
        if (event.data.enableProgress === true && !exactWinningPass && topN > 0) {
          for (const point of engine.validPositions) {
            if ((globalThis.performance?.now?.() ?? Date.now()) >= decisionDeadline) break;
            if (!engine._evaluateMove(point, aiPlayer).legal) continue;
            publishProgress({ point, score: null }, "first-legal-action-not-policy");
            break;
          }
        }
        let rankedMoves = exactWinningPass ? [exactWinningPass] : ai.getTopMoves(
          engine,
          aiPlayer,
          topN > 0 ? Math.max(2, topN) : topN,
          {
            terminalWinningPassPrechecked: strategy === "multiplayer",
            deadline: decisionDeadline,
            onProgress: /* @__PURE__ */ __name((move) => publishProgress(move, "partial-policy-candidate"), "onProgress")
          }
        );
        const usedProgressFallback = topN > 0 && !rankedMoves.length && Boolean(bestProgress);
        if (usedProgressFallback) rankedMoves = [bestProgress];
        if (topN > 0 && !rankedMoves.length && event.data.enableProgress === true && (globalThis.performance?.now?.() ?? Date.now()) >= decisionDeadline) {
          throw new Error("AI decision budget expired without a verified legal action.");
        }
        const overlayDeadline = Math.min(
          decisionDeadline,
          (globalThis.performance?.now?.() ?? Date.now()) + 200
        );
        const tactical = exactWinningPass || topN <= 0 || engine.rootRulesVersion === "root-v2" ? { moves: rankedMoves, receipt: { status: "not-applicable", complete: false } } : applyRootTacticalOverlay(engine, aiPlayer, rankedMoves, { deadline: overlayDeadline });
        const moves = tactical.moves.slice(0, Math.max(0, Math.floor(topN)));
        self.postMessage({
          type: "RESULT",
          requestId,
          strategy,
          positionRevision: serializedState.positionRevision ?? 0,
          rulesVersion: serializedState.rulesVersion,
          protectionRule: serializedState.protectionRule,
          currentPlayer: serializedState.currentPlayer,
          rootStateIdentity: serializedState.rootStateIdentity,
          moves,
          modelInfo,
          tacticalInfo: tactical.receipt,
          ...ai.lastSearch || usedProgressFallback ? { searchStats: {
            ...ai.lastSearch ?? {},
            ...usedProgressFallback ? { partial: true, decisionSource: "verified-progress-fallback" } : {}
          } } : {}
        });
      } catch (error) {
        self.postMessage({
          type: "ERROR",
          requestId: event.data?.requestId ?? null,
          positionRevision: event.data?.serializedState?.positionRevision ?? 0,
          rulesVersion: event.data?.serializedState?.rulesVersion,
          protectionRule: event.data?.serializedState?.protectionRule,
          currentPlayer: event.data?.serializedState?.currentPlayer,
          ...event.data?.serializedState?.isTopologyBoard ? { boardHash: event.data?.serializedState?.boardHash } : {},
          rootStateIdentity: event.data?.serializedState?.rootStateIdentity,
          message: error instanceof Error ? error.message : String(error),
          ...typeof error?.code === "string" && error.code.startsWith("ULTIMATE_") ? { code: error.code } : {}
        });
      }
    };
  }
});

// application-hard:MultiplayerHardWorkerEntry.js
init_MultiplayerHardResources();
init_MultiplayerHardResources();
init_MultiplayerHardWorkerRuntime();
var pending = [], requests = /* @__PURE__ */ new Map();
var post = self.postMessage.bind(self), bootstrapEnteredMs = performance.now();
var originalHandler = null;
function forward(event) {
  const request = requests.get(event.data?.requestId);
  if (request && event.data?.type === "COMPUTE") {
    request.formalDispatchCount++;
    request.formalDispatchMs = performance.now();
  }
  return originalHandler.call(self, event);
}
__name(forward, "forward");
self.addEventListener("message", (event) => {
  event.stopImmediatePropagation();
  const message = event.data;
  if (message?.type === "COMPUTE") {
    const request = {
      queuedBeforeHandler: originalHandler === null,
      formalDispatchCount: 0,
      requestReceivedMs: performance.now(),
      formalDispatchMs: null
    };
    requests.set(message.requestId, request);
    if (message.strategy === "multiplayer" && message.modelId === HARD_MODEL_ID && supportsNativeHardContext(message.serializedState)) {
      prepareHardResources(message.serializedState).catch(() => {
      });
    }
  }
  if (originalHandler) forward(event);
  else pending.push(event);
});
self.postMessage = (message, ...rest) => {
  const request = requests.get(message?.requestId);
  if (!request || !["READY", "RESULT", "ERROR"].includes(message?.type)) return post(message, ...rest);
  const startupStats = { ...request, bootstrapEnteredMs, implementation: "application-single-file-hard-v1" };
  if (message.type !== "READY") requests.delete(message.requestId);
  return post({ ...message, startupStats }, ...rest);
};
await Promise.resolve().then(() => (init_AIWorker(), AIWorker_exports));
originalHandler = self.onmessage;
if (typeof originalHandler !== "function") throw new Error("AIWorker message handler was not installed");
self.onmessage = null;
for (const event of pending.splice(0)) forward(event);
export {
  loadMultiplayerRuntime,
  loadNativeHardRuntime,
  prepareHardResources
};
