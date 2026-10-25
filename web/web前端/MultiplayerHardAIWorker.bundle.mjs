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
function resolveBoardShape(playerCount = 2, boardShape = null) {
  const shape = boardShape ?? (playerCount >= 4 ? "hexagon" : "triangle");
  if (!["triangle", "hexagon"].includes(shape)) throw new Error("Unknown board shape.");
  return shape;
}
function getBoardVertices(gridSize, playerCount = 2, boardShape = null) {
  const r = gridSize - 1;
  return resolveBoardShape(playerCount, boardShape) === "hexagon" ? [[r, 0], [2 * r, 0], [2 * r, r], [r, 2 * r], [0, 2 * r], [0, r]] : [[0, 0], [r, 0], [0, r]];
}
function isBoardPoint(point, gridSize, playerCount = 2, boardShape = null) {
  const x = point?.[0];
  const y = point?.[1];
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) return false;
  const r = gridSize - 1;
  return resolveBoardShape(playerCount, boardShape) === "hexagon" ? x <= 2 * r && y <= 2 * r && x + y >= r && x + y <= 3 * r : x + y <= r;
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
  if (resolveBoardShape(playerCount, boardShape) === "hexagon") {
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
function clonePoint(point) {
  return [point[0], point[1]];
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
  return { ...result, polygon: result.polygon ? result.polygon.map(clonePoint) : null };
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
var DEFAULT_GRID_SIZE, MIN_GRID_SIZE, MAX_GRID_SIZE, TerritoryRulesVersion, SUPPORTED_TERRITORY_RULES, BARYCENTRIC_TRANSFORMS, Player, PointState, PLAYER_ORDER, DIRECTIONS, DIRS_CW, PLAYER_POINT_STATES, GameEngine, NATIVE_TERRITORY_METHODS, NATIVE_SHARED_TERRITORY_METHODS, NATIVE_FLOOD_COVERAGE, NATIVE_FLOOD_POINT_INDEX, TERRITORY_DEPENDENCY_MEMOS, NATIVE_DEPENDENCY_METHODS, GameEngine_default;
var init_GameEngine = __esm({
  "application-hard:GameEngine.js"() {
    DEFAULT_GRID_SIZE = 9;
    MIN_GRID_SIZE = 5;
    MAX_GRID_SIZE = 15;
    TerritoryRulesVersion = Object.freeze({
      V1: "territory-v1",
      V2: "territory-v2",
      V3: "territory-v3"
    });
    SUPPORTED_TERRITORY_RULES = new Set(Object.values(TerritoryRulesVersion));
    BARYCENTRIC_TRANSFORMS = Object.freeze({
      IDENTITY: Object.freeze([0, 1, 2]),
      SWAP_XY: Object.freeze([1, 0, 2]),
      SWAP_YZ: Object.freeze([0, 2, 1]),
      SWAP_XZ: Object.freeze([2, 1, 0]),
      CYCLE_XYZ: Object.freeze([1, 2, 0]),
      CYCLE_XZY: Object.freeze([2, 0, 1])
    });
    Player = Object.freeze({
      BLACK: "BLACK",
      WHITE: "WHITE",
      PURPLE: "PURPLE",
      GREEN: "GREEN",
      ORANGE: "ORANGE",
      CYAN: "CYAN"
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
      CYAN_LINE: 12
    });
    PLAYER_ORDER = Object.freeze([
      Player.BLACK,
      Player.WHITE,
      Player.PURPLE,
      Player.GREEN,
      Player.ORANGE,
      Player.CYAN
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
    __name(clonePoint, "clonePoint");
    __name(pointKey, "pointKey");
    __name(keyToPoint, "keyToPoint");
    __name(pointEquals, "pointEquals");
    __name(applyBarycentricTransform, "applyBarycentricTransform");
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
        this.playerCount = options.playerCount ?? 2;
        if (!Number.isInteger(this.playerCount) || this.playerCount < 2 || this.playerCount > 6) {
          throw new Error("playerCount must be an integer between 2 and 6.");
        }
        this.boardShape = resolveBoardShape(this.playerCount, options.boardShape);
        this.boardVertices = getBoardVertices(this.gridSize, this.playerCount, this.boardShape);
        this.activePlayers = PLAYER_ORDER.slice(0, this.playerCount);
        this.hasCustomInitialPositions = options.initialPositions != null;
        this.initialPositions = resolveInitialPositions(this.gridSize, this.playerCount, options.initialPositions, this.boardShape);
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
          this.activePlayers.map((player) => [player, { polygon: null, area: 0, displayArea: 0 }])
        );
        this.edges = Object.fromEntries(this.activePlayers.map((player) => [player, /* @__PURE__ */ new Set()]));
        this.historyHashes = /* @__PURE__ */ new Set();
        this._initGrid();
        for (const player of this.activePlayers) {
          this._setState(this.initialPositions[player], this._getPlayerStates(player).node);
        }
        if (this.rulesVersion === TerritoryRulesVersion.V3) {
          for (const player of this.activePlayers) {
            this.cachedTerritories[player] = { polygon: null, area: 1, displayArea: 1 };
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
              polygon: territory.polygon ? territory.polygon.map(clonePoint) : null
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
              polygon: scores[player].polygon ? scores[player].polygon.map(clonePoint) : null
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
          rulesVersion: this.rulesVersion,
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
          legalMoves: this._getSnapshotLegalMoves()
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
              if (!Array.isArray(point) || point.length !== 2 || !this.isValidPosition(point)) {
                return false;
              }
              polygon.push(clonePoint(point));
            }
          }
          nextTerritories[player] = {
            polygon,
            area: territory.area,
            displayArea: territory.displayArea
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
          const root = this.initialPositions[opponent];
          const dx = point[0] - root[0], dy = point[1] - root[1];
          return DIRECTIONS.some(([x, y]) => dx === x && dy === y);
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
        const initial = this._getInitialPosition(opponent);
        if (this._getState(initial) !== nodeState) return /* @__PURE__ */ new Set();
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
        const initialKey = pointKey(initial);
        const aliveNodes = /* @__PURE__ */ new Set([initialKey]);
        const queue = [initialKey];
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
        const initial = this._getInitialPosition(player);
        if (pointEquals(point, initial)) {
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
        const initialKey = pointKey(initial);
        const visited = /* @__PURE__ */ new Set([initialKey]);
        const queue = [initialKey];
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
        const distances = /* @__PURE__ */ new Map([[startKey, 0]]);
        const predecessors = /* @__PURE__ */ new Map();
        while (qi < queue.length) {
          const current = queue[qi++];
          const currentKey = pointKey(current);
          const currentDistance = distances.get(currentKey);
          for (const next of this.getAdjacentPositions(current)) {
            const nextKey = pointKey(next);
            if (blocked.has(nextKey)) {
              continue;
            }
            const nextDistance = currentDistance + 1;
            if (!distances.has(nextKey)) {
              distances.set(nextKey, nextDistance);
              predecessors.set(nextKey, [currentKey]);
              queue.push(next);
            } else if (distances.get(nextKey) === nextDistance) {
              predecessors.get(nextKey).push(currentKey);
            }
          }
        }
        if (!distances.has(endKey)) {
          return [];
        }
        if (distances.get(endKey) > maxEdges) {
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
        const transform = /* @__PURE__ */ __name((point) => isHexagon ? applyHexTransform(point, this.gridSize, permutation) : applyBarycentricTransform(point, this.gridSize, permutation), "transform");
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
        const inverse = isHexagon ? null : invertPermutation(permutation);
        const polygon = canonicalTerritory.polygon ? canonicalTerritory.polygon.map(
          (point) => isHexagon ? applyHexTransform(point, this.gridSize, permutation, true) : applyBarycentricTransform(point, this.gridSize, inverse)
        ) : null;
        return {
          canonicalKey: canonicalPolygonKey(canonicalTerritory.polygon),
          territory: { ...canonicalTerritory, polygon }
        };
      }
      /** Count friendly points plus enemy-free pockets cut off by friendly points.
       *  Treat every friendly node/line point as a flood-fill wall. This handles
       *  open chains, several pockets and ring-shaped structures with holes; no
       *  single simple polygon is required for the score. */
      _computeOwnedWallArea(ownedPoints, enemyPoints) {
        const ownedKeys = new Set(ownedPoints.map(pointKey));
        const enemyKeys = new Set(enemyPoints.map(pointKey));
        const covered = this._getCoveredPoints(ownedPoints);
        const visited = /* @__PURE__ */ new Set();
        let area = ownedKeys.size;
        for (const point of this.validPositions) {
          const startKey = pointKey(point);
          if (ownedKeys.has(startKey) || visited.has(startKey) || !covered.has(startKey)) continue;
          const queue = [point];
          visited.add(startKey);
          let componentSize = 0;
          let containsEnemy = false;
          for (let head = 0; head < queue.length; head += 1) {
            const current = queue[head];
            const currentKey = pointKey(current);
            componentSize += 1;
            if (enemyKeys.has(currentKey)) containsEnemy = true;
            for (const neighbor of this.getAdjacentPositions(current)) {
              const key3 = pointKey(neighbor);
              if (ownedKeys.has(key3) || visited.has(key3) || !covered.has(key3)) continue;
              visited.add(key3);
              queue.push(neighbor);
            }
          }
          if (!containsEnemy) area += componentSize;
        }
        return area;
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
        return {
          ...territory,
          area: this._computeOwnedWallArea(ownedPoints, enemyPoints),
          displayArea: territory.polygon ? territory.displayArea : ownedPoints.length
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
        return `[${JSON.stringify(nextPlayer)},${JSON.stringify(resignedPlayers)},[${gridEntries.join(",")}],${JSON.stringify(edgeLists)}]`;
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
                polygon: territory.polygon ? territory.polygon.map(clonePoint) : null
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
              polygon: territory.polygon ? territory.polygon.map(clonePoint) : null
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
          rulesVersion: this.rulesVersion
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

// application-hard:AIEngine.js
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
function applyMinimaxAction(engine, point, skipLeafAutoSkip = false) {
  return point === null ? engine.skipTurn().success : applyMoveForAI(engine, point, skipLeafAutoSkip);
}
function fastTerritoryBFS(engine, player) {
  const myStates = engine._getPlayerStates(player);
  const opponentStates = /* @__PURE__ */ new Set();
  for (const opponent of getOpponents(engine, player)) {
    const states = engine._getPlayerStates(opponent);
    opponentStates.add(states.node);
    opponentStates.add(states.line);
  }
  const frontier = [];
  const visited = /* @__PURE__ */ new Set();
  for (const point of engine.validPositions) {
    const state = engine._getState(point);
    if (state === myStates.node || state === myStates.line) {
      const key3 = pointKey2(point);
      visited.add(key3);
      frontier.push(point);
    }
  }
  for (let index = 0; index < frontier.length; index += 1) {
    for (const adjacent of engine.getAdjacentPositions(frontier[index])) {
      const key3 = pointKey2(adjacent);
      if (!visited.has(key3) && !opponentStates.has(engine._getState(adjacent))) {
        visited.add(key3);
        frontier.push(adjacent);
      }
    }
  }
  return visited.size;
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
function boundedRootCutChainRisk(engine, defender) {
  const remainingPlayers = survivingPlayers(engine);
  if (remainingPlayers.length !== 2 || !remainingPlayers.includes(defender)) return null;
  if (engine.gameOver || engine.currentPlayer === defender) {
    return { nodes: 0, coverage: 0, firstCuts: 0, responses: 0, transitions: 0 };
  }
  const reference = materialCounts(engine, defender);
  const origin = saveState(engine);
  const budget = { firstCuts: 0, responses: 0, transitions: 0 };
  const spendTransition = /* @__PURE__ */ __name(() => {
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
function boundedRootCutChainAttack(engine, attacker, defenderReference) {
  const remainingPlayers = survivingPlayers(engine);
  if (remainingPlayers.length !== 2 || !remainingPlayers.includes(attacker)) return null;
  const defender = remainingPlayers.find((player) => player !== attacker);
  if (!defender || !defenderReference) return null;
  const origin = saveState(engine);
  const budget = { responses: 0, secondCuts: 0, transitions: 0 };
  const spendTransition = /* @__PURE__ */ __name(() => {
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
function applyRootCutChainPreference(engine, player, scoredMoves, eligibleKeys) {
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
    const snapshot = saveState(engine);
    try {
      if (!engine.playMove(move.point).success) return scoredMoves;
      if (engine.gameOver || engine.currentPlayer === player) continue;
      const risk = boundedRootCutChainRisk(engine, player);
      if (risk === null) continue;
      const attack = boundedRootCutChainAttack(engine, player, opponentReference);
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
var MINIMAX_WEIGHTS, ROOT_CUT_CHAIN_LIMITS, ROOT_CUT_CHAIN_LIMIT_REACHED, MinimaxAI, GreedyAI, MCTSAI;
var init_AIEngine = __esm({
  "application-hard:AIEngine.js"() {
    init_GameEngine();
    __name(pointKey2, "pointKey");
    __name(getOpponents, "getOpponents");
    __name(cloneCachedTerritories, "cloneCachedTerritories");
    __name(saveState, "saveState");
    __name(restoreState, "restoreState");
    __name(applyMoveForAI, "applyMoveForAI");
    __name(applyMinimaxAction, "applyMinimaxAction");
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
    MinimaxAI = class {
      static {
        __name(this, "MinimaxAI");
      }
      constructor(depth = 3) {
        this.depth = depth;
      }
      getLegalMoves(engine, player) {
        return engine.getLegalMoves(player).map((move) => move.point);
      }
      orderMoves(engine, moves, player) {
        return orderMinimaxMoves(engine, moves, player);
      }
      evaluate(engine, player) {
        if (engine.gameOver) {
          const winner = engine.getWinner();
          if (winner === "DRAW") return 0;
          return winner === player ? 1e6 : -1e6;
        }
        return evaluateMinimax(engine, player);
      }
      minimax(engine, depth, alpha, beta, aiPlayer) {
        if (engine.gameOver || depth === 0) {
          return this.evaluate(engine, aiPlayer);
        }
        const legalMoves = this.getLegalMoves(engine, engine.currentPlayer);
        const ordered = this.orderMoves(engine, legalMoves, engine.currentPlayer);
        const actions = [...ordered, null];
        const maximizingPlayer = engine.currentPlayer === aiPlayer;
        if (maximizingPlayer) {
          let bestValue2 = Number.NEGATIVE_INFINITY;
          for (const point of actions) {
            const snapshot = saveState(engine);
            try {
              const applied = applyMinimaxAction(engine, point, depth === 1);
              if (applied) {
                const value = this.minimax(engine, depth - 1, alpha, beta, aiPlayer);
                bestValue2 = Math.max(bestValue2, value);
                alpha = Math.max(alpha, bestValue2);
              }
            } finally {
              restoreState(engine, snapshot);
            }
            if (beta <= alpha) {
              break;
            }
          }
          return bestValue2;
        }
        let bestValue = Number.POSITIVE_INFINITY;
        for (const point of actions) {
          const snapshot = saveState(engine);
          try {
            const applied = applyMinimaxAction(engine, point, depth === 1);
            if (applied) {
              const value = this.minimax(engine, depth - 1, alpha, beta, aiPlayer);
              bestValue = Math.min(bestValue, value);
              beta = Math.min(beta, bestValue);
            }
          } finally {
            restoreState(engine, snapshot);
          }
          if (beta <= alpha) {
            break;
          }
        }
        return bestValue;
      }
      getTopMoves(engine, aiPlayer, topN = 5) {
        const previousReplayFlag = engine._isReplayingBatch;
        engine._isReplayingBatch = true;
        try {
          const legalMoves = this.getLegalMoves(engine, aiPlayer);
          const ordered = this.orderMoves(engine, legalMoves, aiPlayer);
          const rootCutChainEligible = new Set(ordered.map(pointKey2));
          const previousOpponentMaterial = this.depth > 1 ? opponentRiskMaterial(engine, aiPlayer) : 0;
          const scoredMoves = [];
          for (const point of [...ordered, null]) {
            const snapshot = saveState(engine);
            try {
              const applied = applyMinimaxAction(engine, point, this.depth <= 1);
              if (applied) {
                const immediateRisk = this.depth > 1 ? immediateRiskPenalty(engine, aiPlayer, previousOpponentMaterial) : 0;
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
                  score: score - MINIMAX_WEIGHTS.rootRiskAversion * immediateRisk
                });
              }
            } finally {
              restoreState(engine, snapshot);
            }
          }
          scoredMoves.sort((a, b) => b.score - a.score);
          if (this.depth > 1) {
            applyRootCutChainPreference(engine, aiPlayer, scoredMoves, rootCutChainEligible);
          }
          const selectedPass = scoredMoves[0]?.point === null ? scoredMoves[0] : null;
          const placementMoves = scoredMoves.filter(({ point }) => point !== null);
          return (selectedPass ? [selectedPass, ...placementMoves] : placementMoves).slice(0, topN);
        } finally {
          engine._isReplayingBatch = previousReplayFlag;
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
      orderMoves(engine, moves, player) {
        return orderMoves(engine, moves, player);
      }
      getTopMoves(engine, aiPlayer, topN = 5) {
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
            const snapshot = saveState(engine);
            const applied = applyMoveForAI(engine, point, true);
            if (applied) {
              scoredMoves.push({ point, score: evaluate(engine, aiPlayer) });
            }
            restoreState(engine, snapshot);
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
        return applyMoveForAI(engine, point, false);
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
        return Math.tanh(evaluate(engine, rootPlayer) / 100);
      }
      getTopMoves(engine, aiPlayer, topN = 5) {
        const previousReplayFlag = engine._isReplayingBatch;
        engine._isReplayingBatch = true;
        try {
          const rootActions = this.getLegalMoves(engine, aiPlayer);
          if (!rootActions.length) return [];
          const rootSnapshot = saveState(engine);
          const root = {
            playerToAct: aiPlayer,
            parent: null,
            action: null,
            unexpandedActions: rootActions.map((point) => [...point]),
            children: /* @__PURE__ */ new Map(),
            visits: 0,
            valueSum: 0
          };
          try {
            for (let simulation = 0; simulation < this.simulations; simulation += 1) {
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
                    unexpandedActions: this.getLegalMoves(engine, engine.currentPlayer),
                    children: /* @__PURE__ */ new Map(),
                    visits: 0,
                    valueSum: 0
                  };
                  node.children.set(pointKey2(action), child);
                  node = child;
                }
              }
              const value = this.rollout(engine, aiPlayer);
              for (let cursor = node; cursor; cursor = cursor.parent) {
                cursor.visits += 1;
                cursor.valueSum += value;
              }
            }
          } finally {
            restoreState(engine, rootSnapshot);
          }
          return rootActions.map((point) => {
            const child = root.children.get(pointKey2(point));
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
  return { nodes, coverage: nodes + lines, reach: fastTerritoryBFS(engine, player), frontier: frontier.size };
}
function stateFeatures(engine) {
  return Object.fromEntries(engine.activePlayers.map((player) => [player, counts(engine, player)]));
}
function featuresForMove(engine, player, point, before, after, previousState) {
  const count = engine.validPositions.length;
  const opponents = engine.activePlayers.filter((other) => other !== player && !engine.resignedPlayers?.has(other));
  const own = after[player];
  const maximum = /* @__PURE__ */ __name((field) => Math.max(0, ...opponents.map((other) => after[other][field])), "maximum");
  const lost = /* @__PURE__ */ __name((field) => opponents.reduce((total, other) => total + before[other][field] - after[other][field], 0), "lost");
  const scale = engine.gridSize - 1;
  const home = engine.initialPositions[player];
  const dx = point[0] - home[0], dy = point[1] - home[1];
  const distance = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dx + dy)) / scale;
  const barycentric = [point[0], point[1], scale - point[0] - point[1]];
  return [
    own.nodes / count,
    own.coverage / count,
    own.reach / count,
    (own.nodes - maximum("nodes")) / count,
    (own.coverage - maximum("coverage")) / count,
    (own.reach - maximum("reach")) / count,
    lost("nodes") / count,
    lost("coverage") / count,
    (own.nodes - before[player].nodes) / count,
    (own.coverage - before[player].coverage) / count,
    Number(opponents.some((other) => previousState === engine._getPlayerStates(other).line)),
    Number(previousState === engine._getPlayerStates(player).line),
    distance,
    3 * Math.min(...barycentric) / scale,
    own.frontier / count,
    (own.frontier - maximum("frontier")) / count
  ];
}
function threePlayerCandidates(engine, player = engine.currentPlayer) {
  if (engine.currentPlayer !== player) throw new Error("AI \u53EA\u80FD\u5206\u6790\u5F53\u524D\u884C\u52A8\u65B9\u3002");
  if (engine.gameOver) return [];
  const snapshot = saveState(engine);
  const replayFlag = engine._isReplayingBatch;
  engine._isReplayingBatch = true;
  try {
    const before = stateFeatures(engine);
    const candidates = [];
    const legal = engine.getLegalMoves(player);
    for (const { point } of legal) {
      restoreState(engine, snapshot);
      const previousState = engine._getState(point);
      if (!engine.playMove(point).success) continue;
      const after = stateFeatures(engine);
      candidates.push({ point: [...point], features: featuresForMove(engine, player, point, before, after, previousState) });
    }
    return candidates;
  } finally {
    restoreState(engine, snapshot);
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
    MODEL_URL = new URL("./assets/research-ai/three-player-policy-v1.json?v=20261025-unified1", new URL("./ThreePlayerAI.js", self.location.href).href);
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
  const strengths = players.map((p) => areas[p] + spec.coverageWeight * (engine._getPlayerNodes(p).length + engine._getPlayerLines(p).length) + spec.reachWeight * fastTerritoryBFS(engine, p));
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
      getTopMoves(engine, player = engine.currentPlayer, topN = 5) {
        this.lastSearch = { simulations: 0, simulatedActions: 0, terminalLeaves: 0, elapsedMs: 0, evaluated: [] };
        if (engine.playerCount !== 3 || !["territory-v2", "territory-v3"].includes(engine.rulesVersion) || engine.currentPlayer !== player || engine.gridSize < 5 || engine.gridSize > 15) throw new Error("INVALID v4 game contract");
        if (engine.gameOver) return [];
        const snapshot = saveState(engine), flag = engine._isReplayingBatch;
        engine._isReplayingBatch = true;
        const started = Date.now(), stats = { simulations: 0, simulatedActions: 0, terminalLeaves: 0 };
        try {
          const ranked = this.base.getTopMoves(engine, player, this.spec.search.rootWidth);
          if (!ranked.length) return [];
          if (ranked.length === 1) {
            this.lastSearch = { ...stats, elapsedMs: Date.now() - started, evaluated: [], forcedMove: true };
            return ranked.slice(0, Math.max(0, Math.floor(topN)));
          }
          const evaluated = [];
          for (const move of ranked) {
            const leaves = [];
            for (const opponent of this.responses) {
              restoreState(engine, snapshot);
              if (!engine.playMove(move.point).success) throw new Error("INVALID v4 root action");
              stats.simulatedActions++;
              for (let ply = 0; ply < this.spec.search.rolloutPlies && !engine.gameOver; ply++) {
                const policy = engine.currentPlayer === player ? this.base : opponent;
                const reply = policy.getTopMoves(engine, engine.currentPlayer, 1)[0]?.point ?? null;
                const result = reply ? engine.playMove(reply) : engine.skipTurn();
                if (!result.success) throw new Error("INVALID v4 rollout action");
                stats.simulatedActions++;
              }
              const leaf = positionUtilityV4(engine, player, this.spec.search);
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
        } finally {
          restoreState(engine, snapshot);
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
  const own = after[player];
  const maximum = /* @__PURE__ */ __name((field) => Math.max(0, ...opponents.map((other) => after[other][field])), "maximum");
  const lost = /* @__PURE__ */ __name((field) => opponents.reduce((sum, other) => sum + before[other][field] - after[other][field], 0), "lost");
  const radius = engine.gridSize - 1;
  const home = engine.initialPositions[player];
  const axialDistance = /* @__PURE__ */ __name((dx, dy) => Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dx + dy)), "axialDistance");
  const isHex = engine.playerCount >= 4;
  const centrality = isHex ? 1 - axialDistance(point[0] - radius, point[1] - radius) / radius : 3 * Math.min(point[0], point[1], radius - point[0] - point[1]) / radius;
  return [
    own.nodes / count,
    own.coverage / count,
    own.reach / count,
    (own.nodes - maximum("nodes")) / count,
    (own.coverage - maximum("coverage")) / count,
    (own.reach - maximum("reach")) / count,
    lost("nodes") / count,
    lost("coverage") / count,
    (own.nodes - before[player].nodes) / count,
    (own.coverage - before[player].coverage) / count,
    Number(opponents.some((other) => previousState === engine._getPlayerStates(other).line)),
    Number(previousState === engine._getPlayerStates(player).line),
    axialDistance(point[0] - home[0], point[1] - home[1]) / (radius * (isHex ? 2 : 1)),
    centrality,
    own.frontier / count,
    (own.frontier - maximum("frontier")) / count
  ];
}
function hexPlayerCandidates(engine, player = engine.currentPlayer) {
  if (engine.currentPlayer !== player) throw new Error("AI \u53EA\u80FD\u5206\u6790\u5F53\u524D\u884C\u52A8\u65B9\u3002");
  if (engine.gameOver || engine.resignedPlayers.has(player)) return [];
  const snapshot = saveState(engine);
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
      restoreState(engine, snapshot);
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
    restoreState(engine, snapshot);
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
    MODEL_URL2 = new URL("./assets/research-ai/hex-player-policy-v1.json?v=20261025-unified1", new URL("./HexPlayerAI.js", self.location.href).href);
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
  const own = engine._getPlayerStates(player), indices = /* @__PURE__ */ new Set(), geo = boardGeometry(engine);
  const states = geo.keys.map((k) => engine.grid.get(k));
  const enemy = new Set(engine._getOpponents(player).flatMap((p) => Object.values(engine._getPlayerStates(p))));
  const nodes = new Set(engine.activePlayers.map((p) => engine._getPlayerStates(p).node));
  for (let i = 0; i < states.length; i++) {
    if (states[i] !== own.node) continue;
    for (const ray of geo.rays[i]) for (const index of ray) {
      const state = states[index];
      if (!nodes.has(state)) indices.add(index);
      if (enemy.has(state)) break;
    }
  }
  const protectedPoints = new Set(engine._getOpponents(player).flatMap((p) => engine._adjIdxList[engine._keyToIdx.get(key(engine.initialPositions[p]))]));
  return [...indices].sort((a, b) => a - b).filter((i) => {
    if (protectedPoints.has(i)) return false;
    if (enemy.has(states[i])) return true;
    const adjacent = engine._adjIdxList[i].filter((j) => states[j] === own.node);
    return adjacent.length < 2 && adjacent.every((j) => !engine._adjIdxList[j].some((k) => states[k] === own.node));
  }).map((i) => engine.validPositions[i]);
}
function isolatedSearchEngine(source) {
  const engine = new GameEngine({
    gridSize: source.gridSize,
    playerCount: source.playerCount,
    boardShape: source.boardShape,
    initialPositions: source.initialPositions,
    startPlayer: source.startPlayer,
    rulesVersion: source.rulesVersion,
    deferTerritoryUpdates: true
  });
  restoreState(engine, saveState(source));
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
  const own = after[player], max = /* @__PURE__ */ __name((f) => Math.max(0, ...opponents.map((p) => after[p][f])), "max");
  const lost = /* @__PURE__ */ __name((f) => opponents.reduce((v, p) => v + before[p][f] - after[p][f], 0), "lost");
  const home = engine.initialPositions[player], distance = /* @__PURE__ */ __name((x, y) => Math.max(Math.abs(x), Math.abs(y), Math.abs(x + y)), "distance");
  const hex = engine.boardShape === "hexagon";
  return [
    own.nodes / n,
    own.coverage / n,
    own.reach / n,
    (own.nodes - max("nodes")) / n,
    (own.coverage - max("coverage")) / n,
    (own.reach - max("reach")) / n,
    lost("nodes") / n,
    lost("coverage") / n,
    (own.nodes - before[player].nodes) / n,
    (own.coverage - before[player].coverage) / n,
    Number(opponents.some((p) => previous === engine._getPlayerStates(p).line)),
    Number(previous === engine._getPlayerStates(player).line),
    distance(point[0] - home[0], point[1] - home[1]) / (r * (hex ? 2 : 1)),
    hex ? 1 - distance(point[0] - r, point[1] - r) / r : 3 * Math.min(point[0], point[1], r - point[0] - point[1]) / r,
    own.frontier / n,
    (own.frontier - max("frontier")) / n
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
  now = /* @__PURE__ */ __name(() => performance.now(), "now"),
  deadline = null,
  followupMode = "full"
} = {}) {
  if (![3, 4, 5, 6].includes(source.playerCount) || !["territory-v2", "territory-v3"].includes(source.rulesVersion) || !Number.isInteger(source.gridSize) || source.gridSize < 5 || source.gridSize > 15 || source.gameOver || source.resignedPlayers.has(source.currentPlayer) || !Number.isInteger(maxReplies) || maxReplies < 1 || !Number.isInteger(maxProbes) || maxProbes < 1 || !Number.isFinite(timeMs) || timeMs < 0 || typeof now !== "function" || deadline !== null && !Number.isFinite(deadline) || !["full", "minimum", "none"].includes(followupMode))
    throw new Error("Invalid bounded reply-resilience request");
  const started = now();
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
    const time = now();
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
    const next = engine, replySnapshot = saveState(next);
    next.currentPlayer = actor;
    const start = saveState(next), opponents = next._getOpponents(actor);
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
        restoreState(next, start);
      }
      checkBudget();
      return best;
    } finally {
      restoreState(next, replySnapshot);
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
    const snapshot = saveState(engine);
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
        restoreState(engine, snapshot);
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
      restoreState(engine, snapshot);
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
    result.elapsedMs = now() - started;
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
      getTopMoves(source, player = source.currentPlayer, topN = 5) {
        if (!["territory-v2", "territory-v3"].includes(source.rulesVersion) || source.currentPlayer !== player) throw new Error("Invalid multiplayer search state");
        const started = performance.now(), deadline = started + this.timeMs;
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
          if (performance.now() >= deadline || stats.nodes >= this.nodeBudget) throw TIMEOUT;
        }, "check");
        const terminalCache = /* @__PURE__ */ new Map();
        const actions = /* @__PURE__ */ __name(() => [...potentialMoves(engine), ...this.allowPass && !engine.gameOver ? [null] : []], "actions");
        const apply = /* @__PURE__ */ __name((point) => point === null ? engine.skipTurn() : engine.playMove(point), "apply");
        const evaluate2 = /* @__PURE__ */ __name(() => {
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
          const state = point === null ? 0 : engine._getState(point), own = engine._getPlayerStates(actor);
          let score = state && state !== own.line ? 1e3 : state === own.line ? 1 : 0;
          if (preferred?.point && key(point) === key(preferred.point)) score += 1e4;
          return { point, score };
        }).sort((a, b) => b.score - a.score || order(a, b)), "rank");
        const visit = /* @__PURE__ */ __name((depth, alpha, beta) => {
          check2();
          stats.nodes++;
          if (depth === 0 || engine.gameOver) return evaluate2();
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
                score = evaluate2() + this.priorWeight * move.prior;
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
          stats.elapsedMs = performance.now() - started;
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
        const engine = isolatedSearchEngine(source), root = saveState(engine);
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
            restoreState(engine, root);
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
              const evaluate2 = /* @__PURE__ */ __name((move) => {
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
              const entry = evaluate2(entryRoot), evaluated = [entry];
              phase.entryIncumbentScore = entry.score;
              phase.evaluatedRoots = 1;
              published = rank(evaluated, entryKey).ranked;
              phase.selectedScore = entry.score;
              for (const move of roots) {
                if (key2(move.point) === entryKey) continue;
                const candidate = evaluate2(move);
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
      getTopMoves(source, player = source.currentPlayer, topN = 5, { deadline = Infinity, now = /* @__PURE__ */ __name(() => performance.now(), "now") } = {}) {
        this.lastSearch = null;
        this.fullRanking = null;
        if (!["territory-v2", "territory-v3"].includes(source.rulesVersion) || player !== source.currentPlayer || ![3, 4, 5, 6].includes(source.playerCount) || this.searchV4 && source.playerCount !== 3 || Number.isNaN(deadline)) throw new Error("Invalid isolated Hard fallback state/budget");
        const started = now();
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
        const engine = isolatedSearchEngine(source), snapshot = saveState(engine);
        const check2 = /* @__PURE__ */ __name(() => {
          if (now() >= deadline) throw EXPIRED;
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
                restoreState(engine, snapshot);
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
          restoreState(engine, snapshot);
          stats.baselineCandidatesCompleted = baselineCandidates.length;
          stats.elapsedMs = now() - started;
        }
        if (!result.length) {
          result = [{ type: "pass", point: null, score: 0, visits: 1 }];
          if (stats.baselineComplete) stats.decisionSource = "no-legal-placement";
        }
        const moves = result.slice(0, Math.max(0, Math.floor(topN)));
        validateMoves(source, player, moves);
        stats.elapsedMs = now() - started;
        return moves;
      }
    };
  }
});

// application-hard:MultiplayerHardRuntime.js
function scanTacticalDirectCutRisk(source, roots, {
  deadline,
  now = /* @__PURE__ */ __name(() => performance.now(), "now"),
  measurePlacementKeys = /* @__PURE__ */ new Set()
}) {
  const actor = source.currentPlayer, engine = isolatedSearchEngine(source), rootSnapshot = saveState(engine);
  const stats = { complete: false, reason: null, probes: 0, rootsChecked: 0, terminalRoot: null, rows: [] };
  const STOP = Symbol("Hard tactical-ordering deadline");
  const check2 = /* @__PURE__ */ __name(() => {
    const time = now();
    if (!Number.isFinite(time)) throw new Error("Invalid tactical-ordering clock");
    if (time >= deadline) throw STOP;
  }, "check");
  const evaluate2 = engine._evaluateMove;
  const descriptor = Object.getOwnPropertyDescriptor(engine, "_evaluateMove");
  engine._evaluateMove = function(...args) {
    check2();
    stats.probes++;
    const result = evaluate2.apply(this, args);
    check2();
    return result;
  };
  try {
    const enemies = engine.activePlayers.filter((player) => player !== actor && !engine.resignedPlayers.has(player));
    const enemyNodes = enemies.flatMap((player) => engine.validPositions.filter((point) => engine._getState(point) === engine._getPlayerStates(player).node).map((point) => ({ player, coordinate: pointKey3(point) })));
    const byPoint = /* @__PURE__ */ new Map();
    for (const root of roots) {
      check2();
      restoreState(engine, rootSnapshot);
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
      if (root.kind === "placement" && !measurePlacementKeys.has(pointKey3(root.point))) continue;
      const own = engine._getPlayerStates(actor);
      const ownNodes = new Set(engine.validPositions.filter((point) => engine._getState(point) === own.node).map(pointKey3));
      const ownCoverage = new Set(engine.validPositions.filter((point) => [own.node, own.line].includes(engine._getState(point))).map(pointKey3));
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
        const replySnapshot = saveState(engine);
        for (const reply of potentialMoves(engine, row.replyPlayer)) {
          check2();
          if (engine._getState(reply) !== own.line) continue;
          stats.probes++;
          const replyOutcome = engine.playMove(reply);
          check2();
          if (!replyOutcome.success) {
            restoreState(engine, replySnapshot);
            if (["INVALID_MOVE", "SUPERKO_VIOLATION"].includes(replyOutcome.reason)) continue;
            throw new Error(`Illegal Hard tactical-order reply: ${replyOutcome.reason}`);
          }
          row.directCutReplies++;
          const connected = engine._getOpponentConnectedPieces(actor);
          const retainedNodes = [...ownNodes].filter((coordinate) => connected.has(coordinate) && engine.grid.get(coordinate) === own.node).length;
          const retainedCoverage = [...ownCoverage].filter((coordinate) => connected.has(coordinate) && [own.node, own.line].includes(engine.grid.get(coordinate))).length;
          row.maximumNodeLoss = Math.max(row.maximumNodeLoss, ownNodes.size - retainedNodes);
          row.maximumCoverageLoss = Math.max(row.maximumCoverageLoss, ownCoverage.size - retainedCoverage);
          restoreState(engine, replySnapshot);
        }
      }
      row.worstNetNodeGain = row.capturedNodes - row.maximumNodeLoss;
      stats.rows.push(row);
      byPoint.set(pointKey3(root.point), row);
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
    restoreState(engine, rootSnapshot);
    if (descriptor) Object.defineProperty(engine, "_evaluateMove", descriptor);
    else delete engine._evaluateMove;
  }
}
function preflightImmediateTerminalRoots(source, roots, { deadline, now = /* @__PURE__ */ __name(() => performance.now(), "now") }) {
  const stats = { complete: false, terminalRoot: null, attemptedRoots: 0, reason: null };
  const engine = isolatedSearchEngine(source), snapshot = saveState(engine), STOP = Symbol("terminal preflight deadline");
  const check2 = /* @__PURE__ */ __name(() => {
    const time = now();
    if (!Number.isFinite(time)) throw new Error("Invalid terminal preflight clock");
    if (time >= deadline) throw STOP;
  }, "check");
  const evaluate2 = engine._evaluateMove, descriptor = Object.getOwnPropertyDescriptor(engine, "_evaluateMove");
  engine._evaluateMove = function(...args) {
    check2();
    const value = evaluate2.apply(this, args);
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
      restoreState(engine, snapshot);
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
  now = /* @__PURE__ */ __name(() => performance.now(), "now"),
  probe = probeMultiplayerReplyResilience,
  preflight = preflightImmediateTerminalRoots
} = {}) {
  const started = now(), end = Math.min(deadline, started + windowMs);
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
    if (!roots.some((move) => pointKey3(move.point) === pointKey3(anchor.point)))
      throw new Error("Hard reply anchor missing from complete root domain");
    const own = source._getPlayerStates(source.currentPlayer);
    const enemyLines = new Set(source._getOpponents(source.currentPlayer).map((player) => source._getPlayerStates(player).line));
    const kind = /* @__PURE__ */ __name((point) => point === null ? "pass" : enemyLines.has(source._getState(point)) ? "attack" : source._getState(point) === own.line ? "reinforcement" : "placement", "kind");
    const indexed = roots.map((move, rank) => ({ point: copyPoint(move.point), rank, kind: kind(move.point) }));
    const anchorRoot = indexed.find((move) => pointKey3(move.point) === pointKey3(anchor.point));
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
      now,
      measurePlacementKeys: /* @__PURE__ */ new Set([pointKey3(anchorRoot.point)])
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
    const risk = /* @__PURE__ */ __name((move) => riskScan.byPoint.get(pointKey3(move.point)), "risk");
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
    if (new Set(ordered.map((move) => pointKey3(move.point))).size !== ordered.length)
      throw new Error("Duplicate Hard reply roots");
    stats.candidateReachability = ordered.map((move, visitOrder) => ({
      ...move,
      visitOrder,
      directCutPriority: move === priority,
      directCutRisk: riskScan.byPoint.has(pointKey3(move.point)) ? {
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
    } : preflight(source, ordered, { deadline: end, now });
    if (!stats.terminalPreflight.complete || stats.terminalPreflight.terminalRoot !== null) {
      stats.reason = stats.terminalPreflight.reason;
      return { moves: null, stats };
    }
    stats.reason = "no-strict-improvement";
    for (const root of ordered) {
      const remaining = end - now();
      if (remaining <= 0) {
        stats.reason = "deadline";
        break;
      }
      const attempt = { point: copyPoint(root.point), rank: root.rank, kind: root.kind, complete: false };
      stats.attemptedRoots.push(attempt);
      let packet = probe(source, root.point, {
        deadline: end,
        timeMs: remaining,
        now,
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
      if (pointKey3(packet.rootPoint) !== pointKey3(root.point) || packet.player !== source.currentPlayer)
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
            if (prior.conditionalFollowupComplete || now() >= end) return prior;
            const extended = probe(source, prior.rootPoint, {
              deadline: end,
              timeMs: Math.max(0, end - now()),
              now,
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
            if (pointKey3(extended.rootPoint) !== pointKey3(prior.rootPoint) || extended.player !== prior.player || ["maximumNodeLoss", "maximumCoverageLoss", "worstNetNodeGain", "allRepliesRetainAttackNode"].some((name) => extended[name] !== prior[name])) throw new Error("Conditional replay changed complete defense packet");
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
    stats.accepted = selected !== null && pointKey3(selected.rootPoint) !== pointKey3(anchor.point);
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
    stats.elapsedMs = now() - started;
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
    getTopMoves(source, player = source.currentPlayer, topN = 5) {
      const started = performance.now(), deadline = started + this.timeMs;
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
        const fallbackMs = performance.now() - started;
        if (performance.now() >= deadline) {
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
            const selectedKey = pointKey3(tactical.moves[0].point);
            return [...tactical.moves, ...moves.filter((move) => pointKey3(move.point) !== selectedKey)].slice(0, Math.max(1, Math.floor(topN)));
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
          elapsedMs: performance.now() - started,
          fallbackSearch: structuredClone(details),
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
var HARD_EXPERIMENT_OPTIONS, HARD_REPLY_WINDOW_MS, pointKey3, copyPoint, responseScope, packetSummary;
var init_MultiplayerHardRuntime = __esm({
  "application-hard:MultiplayerHardRuntime.js"() {
    init_MultiplayerHardRollout();
    init_MultiplayerHardFallback();
    init_MultiplayerSearch();
    init_MultiplayerHardValue();
    init_AIEngine();
    HARD_EXPERIMENT_OPTIONS = Object.freeze({
      timeMs: 650,
      rolloutPlies: Object.freeze([12, 24]),
      minimumImprovement: 0.02,
      candidateCap: null,
      allowPass: true,
      rootPriors: null
    });
    HARD_REPLY_WINDOW_MS = 220;
    pointKey3 = /* @__PURE__ */ __name((point) => point === null ? "PASS" : point.join(","), "pointKey");
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
  const general = await import("./MultiplayerRuntime.js?v=20261025-unified1");
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
      if (!value || !Number.isInteger(value.playerCount) || value.playerCount < 3 || value.playerCount > 6 || !Number.isInteger(value.gridSize) || value.gridSize < 5 || value.gridSize > 15 || !["triangle", "hexagon"].includes(value.boardShape) || !["territory-v2", "territory-v3"].includes(value.rulesVersion)) return null;
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

// application-hard:AIStateProtocol.js
function serializeEngineState(engine) {
  if (!engine) {
    throw new Error("serializeEngineState requires a GameEngine instance.");
  }
  return {
    gridSize: engine.gridSize,
    playerCount: engine.playerCount,
    boardShape: engine.boardShape,
    startPlayer: engine.startPlayer,
    ...engine.hasCustomInitialPositions ? { initialPositions: structuredClone(engine.initialPositions) } : {},
    rulesVersion: engine.rulesVersion,
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
    engine && message && engine.positionRevision === message.positionRevision && engine.rulesVersion === message.rulesVersion && engine.currentPlayer === message.currentPlayer
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
    currentPlayer: engine.currentPlayer
  });
}
function isWorkerResultForRequest(engine, request, message) {
  return Boolean(
    request && message && message.requestId === request.requestId && engine === request.engine && engine.positionRevision === request.positionRevision && engine.rulesVersion === request.rulesVersion && engine.currentPlayer === request.currentPlayer && message.positionRevision === request.positionRevision && message.rulesVersion === request.rulesVersion && message.currentPlayer === request.currentPlayer
  );
}
var init_AIStateProtocol = __esm({
  "application-hard:AIStateProtocol.js"() {
    __name(serializeEngineState, "serializeEngineState");
    __name(deserializeEngineEdges, "deserializeEngineEdges");
    __name(isWorkerResultCurrent, "isWorkerResultCurrent");
    __name(captureWorkerRequest, "captureWorkerRequest");
    __name(isWorkerResultForRequest, "isWorkerResultForRequest");
  }
});

// application-hard:AIWorker.js
var AIWorker_exports = {};
function canonicalTerminalWinningPass(engine, player, now = () => performance.now()) {
  try {
    const started = now();
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
      rulesVersion: engine.rulesVersion,
      deferTerritoryUpdates: true
    });
    restoreState(isolated, saveState(engine));
    isolated._isReplayingBatch = true;
    if (!isolated._hasValidMoves(player)) return null;
    if (now() >= deadline) return null;
    const result = isolated.skipTurn();
    if (!result.success || !isolated.gameOver) return null;
    if (now() >= deadline) return null;
    GameEngine.prototype._updateTerritories.call(isolated);
    if (now() >= deadline) return null;
    const bestArea = Math.max(...remaining.map((candidate) => isolated.cachedTerritories[candidate].area));
    const winners = remaining.filter((candidate) => isolated.cachedTerritories[candidate].area === bestArea);
    const winner = isolated.getWinner();
    if (now() >= deadline || winners.length !== 1 || winners[0] !== player || winner !== player) return null;
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
      try {
        const {
          serializedState,
          aiPlayer,
          depth = 3,
          topN = 5,
          strategy = "minimax",
          requestId = null
        } = event.data;
        const engine = new GameEngine({
          gridSize: serializedState.gridSize,
          playerCount: serializedState.playerCount,
          boardShape: serializedState.boardShape,
          startPlayer: serializedState.startPlayer,
          initialPositions: serializedState.initialPositions,
          rulesVersion: serializedState.rulesVersion
        });
        restoreState(engine, {
          grid: new Map(serializedState.gridEntries),
          edges: deserializeEngineEdges(serializedState, engine.activePlayers),
          historyHashes: new Set(serializedState.historyHashes),
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
        let ai = null;
        let modelInfo = null;
        if (strategy === "greedy") {
          ai = new GreedyAI();
        } else if (strategy === "minimax") {
          ai = new MinimaxAI(depth);
        } else if (strategy === "mcts") {
          ai = new MCTSAI({
            simulations: event.data?.simulations ?? 64,
            rolloutDepth: event.data?.rolloutDepth ?? 40,
            seed: event.data?.seed ?? 521288629
          });
        } else if (strategy === "neural-puct") {
          if (engine.playerCount !== 2) throw new Error("\u6A21\u578B\u4E0D\u652F\u6301\u6B64\u68CB\u76D8/\u89C4\u5219/\u73A9\u5BB6\u6570\u3002");
          const { loadResearchModel, NeuralPUCTAI, supportsResearchInference } = await import("./ResearchAI.js?v=20261025-unified1");
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
          const { loadModelFreeModel, ModelFreeAI } = await import("./ModelFreeAI.js?v=20261025-unified1");
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
          const { loadHexPlayerRuntime } = await import("./HexPlayerRuntime.js?v=20261025-unified1");
          const runtime = await loadHexPlayerRuntime(event.data?.modelId, engine);
          ai = runtime.ai;
          modelInfo = runtime.modelInfo;
        }
        if (!ai) {
          throw new Error(`Unsupported AI strategy: ${strategy}`);
        }
        const exactWinningPass = topN > 0 ? canonicalTerminalWinningPass(engine, aiPlayer) : null;
        if (strategy === "multiplayer") {
          self.postMessage({
            type: "READY",
            requestId,
            strategy,
            positionRevision: serializedState.positionRevision ?? 0,
            rulesVersion: serializedState.rulesVersion,
            currentPlayer: serializedState.currentPlayer,
            modelInfo
          });
        }
        const moves = exactWinningPass ? [exactWinningPass] : ai.getTopMoves(
          engine,
          aiPlayer,
          topN,
          strategy === "multiplayer" ? { terminalWinningPassPrechecked: true } : void 0
        );
        self.postMessage({
          type: "RESULT",
          requestId,
          strategy,
          positionRevision: serializedState.positionRevision ?? 0,
          rulesVersion: serializedState.rulesVersion,
          currentPlayer: serializedState.currentPlayer,
          moves,
          modelInfo,
          ...ai.lastSearch ? { searchStats: ai.lastSearch } : {}
        });
      } catch (error) {
        self.postMessage({
          type: "ERROR",
          requestId: event.data?.requestId ?? null,
          positionRevision: event.data?.serializedState?.positionRevision ?? 0,
          rulesVersion: event.data?.serializedState?.rulesVersion,
          currentPlayer: event.data?.serializedState?.currentPlayer,
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
