const DEFAULT_GRID_SIZE = 9;
const MIN_GRID_SIZE = 5;
const MAX_GRID_SIZE = 15;

export const TerritoryRulesVersion = Object.freeze({
  V1: "territory-v1",
  V2: "territory-v2",
  V3: "territory-v3",
});

const SUPPORTED_TERRITORY_RULES = new Set(Object.values(TerritoryRulesVersion));

// Triangular coordinates are barycentric triples (x, y, z) with
// z = gridSize - 1 - x - y. Every D3 board symmetry is a permutation of
// those three coordinates. A permutation stores new[i] = old[permutation[i]].
const BARYCENTRIC_TRANSFORMS = Object.freeze({
  IDENTITY: Object.freeze([0, 1, 2]),
  SWAP_XY: Object.freeze([1, 0, 2]),
  SWAP_YZ: Object.freeze([0, 2, 1]),
  SWAP_XZ: Object.freeze([2, 1, 0]),
  CYCLE_XYZ: Object.freeze([1, 2, 0]),
  CYCLE_XZY: Object.freeze([2, 0, 1]),
});

// GameEngine 鍙叧蹇冭鍒欑姸鎬侊紝涓嶅叧蹇?Canvas銆乂ue 鎴?WebSocket銆?// 鍙屼汉/涓変汉妯″紡鐨勫樊寮備富瑕佷綋鐜板湪鐜╁鏋氫妇銆佸垵濮嬭惤鐐瑰拰杞崲椤哄簭涓婏紝
// 杈圭晫銆侀潰绉€佺鎾炵瓑鍑犱綍閫昏緫灏介噺淇濇寔涓庣帺瀹舵暟閲忚В鑰︺€?
export const Player = Object.freeze({
  BLACK: "BLACK",
  WHITE: "WHITE",
  PURPLE: "PURPLE",
  GREEN: "GREEN",
  ORANGE: "ORANGE",
  CYAN: "CYAN",
  PINK: "PINK", BROWN: "BROWN", LIME: "LIME", NAVY: "NAVY", GOLD: "GOLD",
  TEAL: "TEAL", MAGENTA: "MAGENTA", SLATE: "SLATE", CORAL: "CORAL",
});

export const PointState = Object.freeze({
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
  PINK_NODE: 13, PINK_LINE: 14,
  BROWN_NODE: 15, BROWN_LINE: 16,
  LIME_NODE: 17, LIME_LINE: 18,
  NAVY_NODE: 19, NAVY_LINE: 20,
  GOLD_NODE: 21, GOLD_LINE: 22,
  TEAL_NODE: 23, TEAL_LINE: 24,
  MAGENTA_NODE: 25, MAGENTA_LINE: 26,
  SLATE_NODE: 27, SLATE_LINE: 28,
  CORAL_NODE: 29, CORAL_LINE: 30,
});

export const PLAYER_ORDER = Object.freeze([
  Player.BLACK, Player.WHITE, Player.PURPLE, Player.GREEN, Player.ORANGE, Player.CYAN,
  Player.PINK, Player.BROWN, Player.LIME, Player.NAVY, Player.GOLD,
  Player.TEAL, Player.MAGENTA, Player.SLATE, Player.CORAL,
]);
const DIRECTIONS = Object.freeze([
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, -1],
  [-1, 1],
]);

// 右手摸墙法使用的顺时针方向序列：E→SE→SW→W→NW→NE
const DIRS_CW = Object.freeze([[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]]);

const PLAYER_POINT_STATES = Object.freeze({
  ...Object.fromEntries(PLAYER_ORDER.map(player => [player, Object.freeze({
    node: PointState[`${player}_NODE`], line: PointState[`${player}_LINE`],
  })])),
  [Player.BLACK]: Object.freeze({
    node: PointState.BLACK_NODE,
    line: PointState.BLACK_LINE,
  }),
  [Player.WHITE]: Object.freeze({
    node: PointState.WHITE_NODE,
    line: PointState.WHITE_LINE,
  }),
  [Player.PURPLE]: Object.freeze({
    node: PointState.PURPLE_NODE,
    line: PointState.PURPLE_LINE,
  }),
  [Player.GREEN]: Object.freeze({
    node: PointState.GREEN_NODE,
    line: PointState.GREEN_LINE,
  }),
  [Player.ORANGE]: Object.freeze({
    node: PointState.ORANGE_NODE,
    line: PointState.ORANGE_LINE,
  }),
  [Player.CYAN]: Object.freeze({
    node: PointState.CYAN_NODE,
    line: PointState.CYAN_LINE,
  }),
});

/** Vertices follow the renderer's clockwise order, beginning at upper left.
 *  gridSize is the number of lattice points along each board side. */
export function resolveBoardShape(playerCount = 2, boardShape = null) {
  const shape = boardShape ?? (playerCount >= 4 ? "hexagon" : "triangle");
  if (!["triangle", "hexagon"].includes(shape)) throw new Error("Unknown board shape.");
  return shape;
}

export function getBoardVertices(gridSize, playerCount = 2, boardShape = null) {
  const r = gridSize - 1;
  return resolveBoardShape(playerCount, boardShape) === "hexagon"
    ? [[r, 0], [2 * r, 0], [2 * r, r], [r, 2 * r], [0, 2 * r], [0, r]]
    : [[0, 0], [r, 0], [0, r]];
}

export function isBoardPoint(point, gridSize, playerCount = 2, boardShape = null) {
  const x = point?.[0];
  const y = point?.[1];
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) return false;
  const r = gridSize - 1;
  return resolveBoardShape(playerCount, boardShape) === "hexagon"
    ? x <= 2 * r && y <= 2 * r && x + y >= r && x + y <= 3 * r
    : x + y <= r;
}

export function getBoardPositions(gridSize, playerCount = 2, boardShape = null) {
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
  if (resolveBoardShape(playerCount, boardShape) === "hexagon") {
    const vertices = getBoardVertices(gridSize, playerCount, "hexagon");
    const occupiedVertices = playerCount === 2 ? [0, 3] : playerCount === 3 ? [0, 2, 4]
      : playerCount === 4 ? [0, 1, 3, 4] : [0, 1, 2, 3, 4, 5];
    return Object.freeze(Object.fromEntries(PLAYER_ORDER.slice(0, playerCount).map(
      (player, index) => [player, Object.freeze(vertices[occupiedVertices[index]])],
    )));
  }
  // Three-player mode starts from the three corners to keep opening pressure balanced.
  if (playerCount === 2) {
    return Object.freeze({
      [Player.BLACK]: Object.freeze([0, 0]),
      [Player.WHITE]: Object.freeze([gridSize - 1, 0]),
    });
  }

  const r = gridSize - 1;
  const mid = Math.floor(r / 2);
  // Extra seats follow the outer sides BLACK→WHITE→PURPLE→BLACK.
  // Even side lengths have two central nodes: use the first along each side.
  const seats = [[0, 0], [0, r], [r, 0], [0, mid], [mid, r - mid], [r - mid, 0]];
  return Object.freeze(Object.fromEntries(PLAYER_ORDER.slice(0, playerCount).map(
    (player, index) => [player, Object.freeze(seats[index])],
  )));
}

// Starting nodes are part of the match configuration, not editable board state.
// Validate and copy them so a settings draft cannot move a live game's roots.
export function resolveInitialPositions(gridSize, playerCount, positions = null, boardShape = null) {
  if (positions == null) return buildInitialPositions(gridSize, playerCount, boardShape);
  const players = PLAYER_ORDER.slice(0, playerCount);
  if (typeof positions !== "object" || Array.isArray(positions)
    || Object.keys(positions).length !== players.length) {
    throw new Error("Each player must have exactly one starting point.");
  }
  const occupied = new Set();
  const result = {};
  for (const player of players) {
    const point = positions[player];
    if (!Array.isArray(point) || point.length !== 2 || !isBoardPoint(point, gridSize, playerCount, boardShape)) {
      throw new Error(`Invalid starting point for ${player}.`);
    }
    const key = pointKey(point);
    if (occupied.has(key)) throw new Error("Starting points must not overlap.");
    occupied.add(key);
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

function keyToPoint(key) {
  const [x, y] = key.split(",").map(Number);
  return [x, y];
}

function pointEquals(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function applyBarycentricTransform(point, gridSize, permutation) {
  const barycentric = [point[0], point[1], gridSize - 1 - point[0] - point[1]];
  return [barycentric[permutation[0]], barycentric[permutation[1]]];
}

// D6 acts on centered axial coordinates. Rotation advances one vertex clockwise;
// reflection fixes vertex 1. These maps preserve all six lattice directions.
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
  const openPolygon = polygon.length > 1 && pointEquals(polygon[0], polygon[polygon.length - 1])
    ? polygon.slice(0, -1)
    : polygon;
  if (!openPolygon.length) return "";

  const representations = [];
  for (const oriented of [openPolygon, [...openPolygon].reverse()]) {
    for (let offset = 0; offset < oriented.length; offset += 1) {
      representations.push(
        [...oriented.slice(offset), ...oriented.slice(0, offset)].map(pointKey).join("|"),
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
  const seen = new Set();
  const result = [];
  for (const point of points) {
    const key = pointKey(point);
    if (!seen.has(key)) {
      seen.add(key);
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


export class GameEngine {
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
      configurable: false,
    });
    this.playerCount = options.playerCount ?? 2;
    if (!Number.isInteger(this.playerCount) || this.playerCount < 2 || this.playerCount > 15) {
      throw new Error("playerCount must be an integer between 2 and 15.");
    }
    this.boardShape = resolveBoardShape(this.playerCount, options.boardShape);
    this.boardVertices = getBoardVertices(this.gridSize, this.playerCount, this.boardShape);
    // activePlayers is the single source of truth for turn order and rules.
    this.activePlayers = PLAYER_ORDER.slice(0, this.playerCount);
    this.hasCustomInitialPositions = options.initialPositions != null;
    this.initialPositions = resolveInitialPositions(this.gridSize, this.playerCount, options.initialPositions, this.boardShape);
    this.startPlayer = this.activePlayers.includes(options.startPlayer) ? options.startPlayer : this.activePlayers[0];

    this.validPositions = [];
    this.positionKeys = new Set();
    this.grid = new Map();
    this.currentPlayer = this.startPlayer;
    this.gameOver = false;
    this.consecutiveSkips = 0;
    this.resignedPlayers = new Set();
    this.turnCount = 0;
    this.positionRevision = 0;
    // The UI can defer the expensive, display-only territory calculation to a
    // Worker on large boards.  Rule legality and Superko never consult this
    // cache, but terminal winner calculation always brings it up to date.
    this.deferTerritoryUpdates = Boolean(options.deferTerritoryUpdates);
    this._territoryStateRevision = 0;
    this._territoryCacheRevision = 0;
    this._isReplayingBatch = false;
    this.cachedTerritories = Object.fromEntries(
      this.activePlayers.map((player) => [player, { polygon: null, area: 0, displayArea: 0 }]),
    );
    // 显式边集合：每条边的 key = 两个节点 pointKey 升序排列后用 | 拼接
    // 仅用于连通性判断，渲染仍依赖 this.grid
    this.edges = Object.fromEntries(this.activePlayers.map((player) => [player, new Set()]));

    // 全局同形再现禁手：记录历史局面哈希，防止打劫循环
    this.historyHashes = new Set();

    this._initGrid();
    for (const player of this.activePlayers) {
      this._setState(this.initialPositions[player], this._getPlayerStates(player).node);
    }
    // A fresh board contains only one isolated starting node per player.
    // v3 counts that node immediately; earlier rules start at zero.
    if (this.rulesVersion === TerritoryRulesVersion.V3) {
      for (const player of this.activePlayers) {
        this.cachedTerritories[player] = { polygon: null, area: 1, displayArea: 1 };
      }
    }

    // 将初始局面写入历史，防止任何操作回到起始状态
    this.historyHashes.add(this._computeStateHash(this.startPlayer));
  }

  _initGrid() {
    // 第一遍：建立索引映射
    this._keyToIdx = new Map();
    // Each board row is contiguous. Keep the integer offset so scoring does
    // not repeatedly allocate coordinate strings for hexagon vertices.
    this._rowIndexOffsets = [];
    this._rowIndexGridSize = this.gridSize;
    this._rowIndexBoardShape = this.boardShape;
    for (const point of getBoardPositions(this.gridSize, this.playerCount, this.boardShape)) {
      const key = pointKey(point);
      const idx = this.validPositions.length;
      this.validPositions.push(point);
      this.positionKeys.add(key);
      this.grid.set(key, PointState.EMPTY);
      this._keyToIdx.set(key, idx);
      this._rowIndexOffsets[point[1]] ??= idx - point[0];
    }

    const n = this.validPositions.length;

    // 预计算邻接整数下标表（避免在 BFS 热路径中反复创建字符串）
    this._adjIdxList = new Array(n);
    for (let i = 0; i < n; i += 1) {
      const [x, y] = this.validPositions[i];
      const adj = [];
      for (const [dx, dy] of DIRECTIONS) {
        const k = `${x + dx},${y + dy}`;
        const ni = this._keyToIdx.get(k);
        if (ni !== undefined) adj.push(ni);
      }
      this._adjIdxList[i] = adj;
    }

    // A boundary point has at least one lattice neighbor outside the board.
    // This includes all six physical sides of a hexagonal board.
    this._boundaryIdxs = [];
    for (let i = 0; i < n; i += 1) {
      if (this._adjIdxList[i].length < DIRECTIONS.length) {
        this._boundaryIdxs.push(i);
      }
    }

    // 预分配可复用 BFS 缓冲区（避免 _getCoveredPoints 每次 new）
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
      return Number.isInteger(x) && Number.isInteger(y)
        && x >= 0 && y >= 0 && x <= 2 * radius && y <= 2 * radius
        && x + y >= radius && x + y <= 3 * radius
        ? (this._rowIndexGridSize === this.gridSize && this._rowIndexBoardShape === this.boardShape
          ? this._rowIndexOffsets[y] + x
          : this._keyToIdx.get(pointKey(point)) ?? -1)
        : -1;
    }
    if (
      !Number.isInteger(x)
      || !Number.isInteger(y)
      || x < 0
      || y < 0
      || x + y >= this.gridSize
    ) {
      return -1;
    }
    return y * this.gridSize - (y * (y - 1)) / 2 + x;
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
    const key = pointKey(point);
    // A legality probe only needs to undo the cells it actually touches.
    // Keep the first value even when a cut/reconnection writes a cell twice.
    if (this._moveProbeUndo && !this._moveProbeUndo.has(key)) {
      this._moveProbeUndo.set(key, this.grid.get(key));
    }
    this.grid.set(key, state);
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
          polygon: territory.polygon ? territory.polygon.map(clonePoint) : null,
        }];
      }),
    );
  }

  getSnapshot() {
    // Snapshot is the read-only view consumed by the UI and network sync.
    // Resolve terminal territory before copying the display cache.  In
    // deferred mode getWinner() may synchronously refresh a pending cache;
    // doing that first prevents a terminal snapshot from carrying the old
    // scores while reporting the new winner.
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
        },
      ]),
    );
    // Include empty edge sets for inactive colors to avoid renderer fallbacks.
    const edges = Object.fromEntries(
      PLAYER_ORDER.slice(0, Math.max(3, this.playerCount)).map((player) => [
        player,
        this.activePlayers.includes(player) ? [...this._getEdges(player)] : [],
      ]),
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
      legalMoves: this._getSnapshotLegalMoves(),
    };
  }

  _getSnapshotLegalMoves() {
    // UI events and territory completions often request the same position.
    // Compare full rule inputs, not just revision: search/replay clients can
    // edit Maps/Sets in place, and Superko history changes legality by itself.
    // This single-entry cache is only for snapshots; search enumeration keeps
    // using getLegalMoves directly, without constructing cache keys per node.
    const key = JSON.stringify([
      this.gridSize, this.boardShape, this.rulesVersion, this.activePlayers,
      this.positionRevision, this.startPlayer, this.turnCount, this.gameOver, this.consecutiveSkips,
      this.currentPlayer, this.initialPositions, this.validPositions, [...this.positionKeys],
      [...this.grid], this.activePlayers.map(player => [...this._getEdges(player)]),
      [...this.historyHashes], [...this.resignedPlayers],
    ]);
    if (this._snapshotLegalCache?.key !== key) {
      this._snapshotLegalCache = { key, moves: this.getLegalMoves(this.currentPlayer) };
    }
    // Snapshots are detached: a UI caller must not be able to poison the cache.
    return this._snapshotLegalCache.moves.map(move => ({ ...move, point: clonePoint(move.point) }));
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
        displayArea: territory.displayArea,
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

    // A winner must never be derived from the previous board's display cache.
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
    return DIRECTIONS
      .map(([dx, dy]) => [x + dx, y + dy])
      .filter((nextPoint) => this.isValidPosition(nextPoint));
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
    const opponentStates = this._getOpponents(player).map(opponent => this._getPlayerStates(opponent));

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
    if (this._getState(initial) !== nodeState) return new Set();

    // 先把当前局面下已断裂的边从边集中移除，确保边集准确
    this._cleanupBrokenEdges(opponent);

    const edgeSet = this._getEdges(opponent);

    // 构建节点邻接表（仅 node→node）
    const adj = new Map();
    for (const ek of edgeSet) {
      const [ka, kb] = ek.split("|");
      if (!adj.has(ka)) adj.set(ka, []);
      if (!adj.has(kb)) adj.set(kb, []);
      adj.get(ka).push(kb);
      adj.get(kb).push(ka);
    }

    // BFS：从起始节点沿边图遍历可达节点
    const initialKey = pointKey(initial);
    const aliveNodes = new Set([initialKey]);
    const queue = [initialKey];
    while (queue.length > 0) {
      const curr = queue.shift();
      for (const nxt of (adj.get(curr) ?? [])) {
        if (!aliveNodes.has(nxt)) {
          aliveNodes.add(nxt);
          queue.push(nxt);
        }
      }
    }

    // 收集存活节点 + 每条存活边的所有中间线点
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
    // 从边集合构建邻接表
    const adj = new Map();
    for (const ek of edgeSet) {
      const [ka, kb] = ek.split("|");
      if (!adj.has(ka)) adj.set(ka, []);
      if (!adj.has(kb)) adj.set(kb, []);
      adj.get(ka).push(kb);
      adj.get(kb).push(ka);
    }

    const targetKey = pointKey(point);
    const initialKey = pointKey(initial);
    const visited = new Set([initialKey]);
    const queue = [initialKey];

    while (queue.length > 0) {
      const curr = queue.shift();
      if (curr === targetKey) return true;
      for (const nxt of (adj.get(curr) ?? [])) {
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
    // Geometry is fixed for the lifetime of an engine. Reuse the six ordered
    // rays; occupancy and stopping conditions are still read on every crawl.
    this._crawlRays ??= new Map();
    const key = pointKey(node);
    if (!this._crawlRays.has(key)) {
      const rays = DIRECTIONS.map(([dx, dy]) => {
        const ray = [];
        let x = node[0] + dx, y = node[1] + dy;
        while (this.isValidPosition([x, y])) {
          ray.push({ point: [x, y], key: `${x},${y}` });
          x += dx; y += dy;
        }
        return ray;
      });
      this._crawlRays.set(key, rays);
    }
    return this._crawlRays.get(key);
  }

  /** 攻击结束后，沿6个方向爬行重建所有被解锁的连线 */
  _connectAllCrawl(player, knownNodes = null) {
    const { node: nodeState, line: lineState } = this._getPlayerStates(player);
    const oppStates = this._getOpponents(player).flatMap((opp) => {
      const s = this._getPlayerStates(opp);
      return [s.node, s.line];
    });
    const isEnemy = (state) => oppStates.includes(state);
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

    // 攻击前保存各玩家边集合快照，用于事后只还原已有边，不新建边
    const savedEdges = Object.fromEntries(
      this.activePlayers.map((p) => [p, new Set(this._getEdges(p))]),
    );

    // Step 2：落子后的棋盘已经包含新的阻挡点，直接用物理棋盘 BFS 找存活集合。
    const alive = this._getOpponentConnectedPieces(opponent);
    let removedPieces = 0;
    for (const point of this.validPositions) {
      const state = this._getState(point);
      if (
        (state === opponentStates.node || state === opponentStates.line)
        && !alive.has(pointKey(point))
      ) {
        this._setState(point, PointState.EMPTY);
        removedPieces += 1;
      }
    }

    // Step 3：清理断裂的显式边缓存
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
    const distances = new Map([[startKey, 0]]);
    const predecessors = new Map();

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

    // 若最短路径（边数）已不短于弧段长度，buildPaths 生成的所有候选都会被
    // candPerim > bestCandPerim 淘汰，直接跳过重建，节省绝大多数调用开销
    if (distances.get(endKey) > maxEdges) {
      return [];
    }

    const buildPaths = (currentKey) => {
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
    };

    return buildPaths(endKey);
  }

  /** 阶段一：右手摸墙法 — 获取外轮廓 */
  _getOuterContour(player) {
    return this._getOuterContourFromPoints([
      ...this._getPlayerNodes(player),
      ...this._getPlayerLines(player),
    ]);
  }

  _getOuterContourFromPoints(friendlyPoints) {
    const friendlySet = new Set();
    for (const p of friendlyPoints) {
      friendlySet.add(pointKey(p));
    }
    if (friendlySet.size === 0) return [];

    // 起点：x 最小，相同取 y 最小
    let start = null;
    for (const key of friendlySet) {
      const p = keyToPoint(key);
      if (!start || p[0] < start[0] || (p[0] === start[0] && p[1] < start[1])) {
        start = p;
      }
    }

    if (friendlySet.size === 1) return [clonePoint(start)];

    let backtrack = 3; // 初始：从正西方（W）进入，对应方向索引 3
    const contour = [];
    let current = clonePoint(start);
    let firstOutDir = null;
    const maxSteps = friendlySet.size * 6 + 10;

    for (let step = 0; step < maxSteps; step += 1) {
      // 从 (backtrack+1)%6 开始顺时针扫描 6 个方向
      let outDir = null;
      for (let i = 0; i < 6; i += 1) {
        const d = (backtrack + 1 + i) % 6;
        const [dx, dy] = DIRS_CW[d];
        const nxt = [current[0] + dx, current[1] + dy];
        if (friendlySet.has(pointKey(nxt))) {
          outDir = d;
          break;
        }
      }

      if (outDir === null) {
        // 孤立点或死胡同
        contour.push(clonePoint(current));
        break;
      }

      if (firstOutDir === null) {
        firstOutDir = outDir;
        contour.push(clonePoint(current));
      } else if (pointEquals(current, start) && outDir === firstOutDir) {
        break; // 轮廓闭合
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
    const points = pointEquals(polygon[0], polygon[polygon.length - 1])
      ? polygon.slice(0, -1)
      : polygon;
    if (points.length < 3) return false;

    const vertices = new Set();
    const edges = new Set();
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
    // 复用预分配缓冲区，使用 epoch 标记避免清零（每次调用 epoch+1）
    this._bfsEpoch += 1;
    // 如果 epoch 溢出就重置（极罕见，约每 21 亿次调用一次）
    if (this._bfsEpoch === 0x7fffffff) {
      this._bfsWall.fill(0);
      this._bfsWater.fill(0);
      this._bfsRequired.fill(0);
      this._bfsEpoch = 1;
    }
    const epoch = this._bfsEpoch;
    const wall = this._bfsWall;
    const water = this._bfsWater;
    const queue = this._bfsQueue;
    const indexedGeometry = this._rowIndexGridSize === this.gridSize
      && this._rowIndexBoardShape === this.boardShape;

    // 标记墙体（polygon 各顶点）
    for (const p of polygon) {
      const directIdx = indexedGeometry ? this._pointToIndex(p) : -1;
      const idx = directIdx >= 0 ? directIdx : this._keyToIdx.get(pointKey(p));
      if (idx >= 0) wall[idx] = epoch;
    }

    // 从预计算的边界点注水
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

    // 统计领土点数（water[i]===epoch 表示被淹没，不计入领土）
    // Each flooded vertex enters the queue exactly once.
    const count = this.validPositions.length - qlen;

    // 拍摄 water 快照，供 .has() 查询（typed array 拷贝比字符串 Set 快得多）
    const waterSnap = new Int32Array(water);
    const capturedEpoch = epoch;
    const keyToIdx = this._keyToIdx;

    return {
      size: count,
      /** 判断 grid 坐标 key 是否在领土内（未被水淹没） */
      has(k) {
        const idx = keyToIdx.get(k);
        return idx !== undefined && waterSnap[idx] !== capturedEpoch;
      },
    };
  }

  /** Exact boolean form of the native flood-fill coverage test. Envelope
   *  pruning only needs to know whether every friendly node stays dry, so it
   *  can stop at the first flooded friend and need not copy the water buffer.
   *  Full coverage callers still receive an independent snapshot above. */
  _coversFriendlyNodes(polygon, friendlyKeys) {
    if (this._getCoveredPoints !== NATIVE_FLOOD_COVERAGE
      || this._pointToIndex !== NATIVE_FLOOD_POINT_INDEX) {
      const covered = this._getCoveredPoints(polygon);
      return [...friendlyKeys].every(key => covered.has(key));
    }

    this._bfsEpoch += 1;
    if (this._bfsEpoch === 0x7fffffff) {
      this._bfsWall.fill(0);
      this._bfsWater.fill(0);
      this._bfsRequired.fill(0);
      this._bfsEpoch = 1;
    }
    const epoch = this._bfsEpoch;
    const wall = this._bfsWall, water = this._bfsWater;
    const required = this._bfsRequired, queue = this._bfsQueue;
    const indexedGeometry = this._rowIndexGridSize === this.gridSize
      && this._rowIndexBoardShape === this.boardShape;
    for (const point of polygon) {
      const directIdx = indexedGeometry ? this._pointToIndex(point) : -1;
      const index = directIdx >= 0 ? directIdx : this._keyToIdx.get(pointKey(point));
      if (index >= 0) wall[index] = epoch;
    }

    let needsFlood = false;
    for (const key of friendlyKeys) {
      const index = this._keyToIdx.get(key);
      if (index === undefined) return false;
      if (wall[index] !== epoch) {
        required[index] = epoch;
        needsFlood = true;
      }
    }
    // Empty friendly sets and friends already on walls are covered by
    // definition. Marking the polygon first retains malformed-input errors.
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
    if (this._getCoveredPoints !== NATIVE_FLOOD_COVERAGE
      || this._pointToIndex !== NATIVE_FLOOD_POINT_INDEX) {
      const covered = this._getCoveredPoints(polygon);
      if (![...friendlyKeys].every(key => covered.has(key))) return null;
      if ([...enemyKeys].some(key => covered.has(key))) return null;
      return covered.size;
    }
    this._bfsEpoch += 1;
    if (this._bfsEpoch === 0x7fffffff) {
      this._bfsWall.fill(0);
      this._bfsWater.fill(0);
      this._bfsRequired.fill(0);
      this._bfsEpoch = 1;
    }
    const epoch = this._bfsEpoch;
    const wall = this._bfsWall, water = this._bfsWater;
    const required = this._bfsRequired, queue = this._bfsQueue;
    const indexedGeometry = this._rowIndexGridSize === this.gridSize
      && this._rowIndexBoardShape === this.boardShape;
    for (const point of polygon) {
      const directIdx = indexedGeometry ? this._pointToIndex(point) : -1;
      const index = directIdx >= 0 ? directIdx : this._keyToIdx.get(pointKey(point));
      if (index >= 0) wall[index] = epoch;
    }
    for (const key of friendlyKeys) {
      const index = this._keyToIdx.get(key);
      if (index === undefined) return null;
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
    for (const key of enemyKeys) {
      const index = this._keyToIdx.get(key);
      if (index !== undefined && water[index] !== epoch) return null;
    }
    return this.validPositions.length - length;
  }

  /** 从源点对整张棋盘做 BFS（整数下标），返回距离表和前驱表。
   *  使用预计算的 _adjIdxList，避免热路径中的字符串操作。 */
  _bfsFromSource(srcIdx, enemyIdxSet) {
    if (!NATIVE_DEPENDENCY_METHODS.every(([name, method]) => this[name] === method)
      || !(enemyIdxSet instanceof Set) || Object.getPrototypeOf(enemyIdxSet) !== Set.prototype
      || enemyIdxSet.has !== Set.prototype.has || enemyIdxSet[Symbol.iterator] !== Set.prototype[Symbol.iterator]
      || !Number.isInteger(srcIdx) || srcIdx < 0 || srcIdx >= this.validPositions.length) {
      return this._territoryBfsUncached(srcIdx, enemyIdxSet);
    }
    const memo = dependencyMemo(this);
    if (!memo.context) updateDependencyGeometry(this, memo);
    const obstacleKey = memo.context?.enemyIdxSet === enemyIdxSet
      ? memo.context.obstacleKey : [...enemyIdxSet].filter(index => Number.isInteger(index)
        && index >= 0 && index < this.validPositions.length).sort((a, b) => a - b).join(',');
    if (memo.context) Object.assign(memo.context, { enemyIdxSet, obstacleKey });
    const exact = dependencyBfsGet(memo.bfs, obstacleKey, srcIdx);
    if (exact) {
      memo.stats.bfsExactHits++;
      return unpackDependencyBfs(exact.result);
    }
    // A BFS reads obstacle membership only in neighbors of reached vertices.
    // If that entire read set agrees, induction on the original queue proves
    // identical distance/predecessor arrays, including predecessor order.
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
    // The per-view admission bound also avoids packing results that would be
    // discarded immediately; the original caller still receives its result.
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

    yield* visit(tgtIdx);
  }

  // Compatibility helper for diagnostics that explicitly request an array.
  _reconstructPaths(bfsResult, srcIdx, tgtIdx) {
    return [...this._iterateReconstructedPaths(bfsResult, srcIdx, tgtIdx)];
  }

  /** Keep old diagnostic/subclass overrides observable while the default path
   *  remains streaming and does not materialize the predecessor DAG. */
  *_iterateTerritoryPaths(bfsResult, srcIdx, tgtIdx) {
    if (this._reconstructPaths !== GameEngine.prototype._reconstructPaths) {
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
    const counts = sharedPaths?.counts ?? new Map([[srcIdx, 1]]);
    const countPaths = index => {
      if (!counts.has(index)) {
        let count = 0;
        for (const previous of pred[index] ?? []) count = Math.min(16, count + countPaths(previous));
        counts.set(index, count);
      }
      return counts.get(index);
    };
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
    // A valid territory contains its walls AND every friendly node. Remaining
    // shortest-path vertices strictly decrease BFS distance, so they never
    // repeat the selected suffix (apart from the current endpoint). A 0/1
    // shortest-path DP therefore gives a lower bound on final covered points.
    const makeAreaBound = fixed => {
      const required = new Set([...fixed.map(pointKey), ...friendlyKeys]
        .map(key => this._keyToIdx.get(key)).filter(index => index !== undefined));
      const weight = index => required.has(index) ? 0 : 1;
      const costs = new Map([[srcIdx, weight(srcIdx)]]);
      const minimumExtra = index => {
        if (!costs.has(index)) {
          let best = Infinity;
          for (const previous of pred[index] ?? []) best = Math.min(best, minimumExtra(previous));
          costs.set(index, best + weight(index));
        }
        return costs.get(index);
      };
      return { required, weight, minimumExtra };
    };
    const areaBounds = sharedPaths && areaLimit ? [makeAreaBound(fixedA), makeAreaBound(fixedB)] : null;
    const ancestors = new Map();
    const ancestorPoints = index => {
      if (!ancestors.has(index)) {
        const union = new Set([index]), pending = [index];
        for (let i = 0; i < pending.length; i++) {
          for (const previous of pred[pending[i]] ?? []) {
            if (!union.has(previous)) { union.add(previous); pending.push(previous); }
          }
        }
        ancestors.set(index, [...union].map(i => vp[i]));
      }
      return ancestors.get(index);
    };
    const engine = this;
    const reversedPath = [tgtIdx];
    function* visit(index, inheritedSides, extraA, extraB) {
      // A failed envelope remains impossible in every descendant: every
      // descendant's wall union is a subset of its ancestor's wall union.
      let sides = sharedPaths ? possibleSides() & inheritedSides : possibleSides();
      if (!sides) return;
      if (areaBounds) {
        for (let side = 0; side < 2; side++) {
          const bit = 1 << side;
          if (!(sides & bit)) continue;
          const limit = areaLimit(bit);
          if (limit === Infinity) continue;
          const bound = areaBounds[side];
          const lowerArea = bound.required.size + (side ? extraB : extraA)
            + bound.minimumExtra(index) - bound.weight(index);
          if (lowerArea >= limit) sides &= ~bit;
        }
        if (!sides) return;
      }
      if (index === srcIdx) {
        if (sharedPaths) sharedPaths.emittedSides = sides;
        yield [...reversedPath].reverse().map(i => clonePoint(vp[i]));
        return;
      }
      // Below sixteen completions the bound costs more than the exact leaf
      // checks. The threshold controls work spent proving impossibility only.
      if (reversedPath.length > 1 && counts.get(index) >= 16) {
        const envelope = [...reversedPath.map(i => vp[i]), ...ancestorPoints(index)];
        const couldCover = fixed => {
          if (sharedPaths) return engine._coversFriendlyNodes([...fixed, ...envelope], friendlyKeys);
          const covered = engine._getCoveredPoints([...fixed, ...envelope]);
          return [...friendlyKeys].every(key => covered.has(key));
        };
        // Prove each side separately, so a successful A envelope does not
        // conceal an impossible B subtree all the way down to the leaves.
        if (sharedPaths) {
          if ((sides & 1) && !couldCover(fixedA)) sides &= ~1;
          if ((sides & 2) && !couldCover(fixedB)) sides &= ~2;
          if (!sides) return;
        } else if (!((sides & 1) && couldCover(fixedA)) && !((sides & 2) && couldCover(fixedB))) return;
      }
      for (const previous of pred[index] ?? []) {
        reversedPath.push(previous);
        yield* visit(previous, sides,
          extraA + (areaBounds ? areaBounds[0].weight(previous) : 0),
          extraB + (areaBounds ? areaBounds[1].weight(previous) : 0));
        reversedPath.pop();
      }
    }
    yield* visit(tgtIdx, 3, areaBounds ? areaBounds[0].weight(tgtIdx) : 0,
      areaBounds ? areaBounds[1].weight(tgtIdx) : 0);
  }

  /** Raw contour-tightening scorer over an explicitly supplied coordinate view. */
  _computeRawTerritory(
    friendlyNodes,
    friendlyLines,
    rawEnemyPoints,
    { requireClosedRegion = false, initialContour = null } = {},
  ) {
    const options = { requireClosedRegion, initialContour };
    if (!NATIVE_DEPENDENCY_METHODS.every(([name, method]) => this[name] === method)) {
      return this._rawTerritoryUncached(friendlyNodes, friendlyLines, rawEnemyPoints, options);
    }
    const nodeKey = dependencyPointsKey(friendlyNodes), lineKey = dependencyPointsKey(friendlyLines);
    const enemyKey = dependencyPointsKey(rawEnemyPoints), contourKey = initialContour ? dependencyPointsKey(initialContour) : '';
    if ([nodeKey, lineKey, enemyKey, contourKey].some(key => key === null)) {
      return this._rawTerritoryUncached(friendlyNodes, friendlyLines, rawEnemyPoints, options);
    }
    const memo = dependencyMemo(this);
    updateDependencyGeometry(this, memo);
    // Friendly order and an explicit initial walk are preserved. Enemy order
    // is irrelevant: the scorer consults only their union as obstacles and in
    // boolean containment tests. This is a pure geometry memo, not a state or
    // legality cache; Superko history, logical edges and turn state are unused.
    const key = `${requireClosedRegion ? 1 : 0}|${nodeKey}|${lineKey}|${[...new Set(enemyKey.split(';'))].sort().join(';')}|${initialContour ? 1 : 0}:${contourKey}`;
    const cached = dependencyGet(memo.raw, key);
    if (cached) {
      memo.stats.rawHits++;
      return copyDependencyTerritory(cached);
    }
    memo.stats.rawMisses++;
    const previousContext = memo.context;
    memo.context = {};
    try {
      const result = this._rawTerritoryUncached(friendlyNodes, friendlyLines, rawEnemyPoints, options);
      dependencyPut(memo.raw, key, copyDependencyTerritory(result), (result.polygon?.length || 0) * 2);
      return result;
    } finally { memo.context = previousContext; }
  }

  _getTerritoryDependencyStats() {
    const memo = dependencyMemo(this);
    return { ...memo.stats, rawEntries: memo.raw.entries.size, rawKeyCharacters: memo.raw.characters,
      rawCoordinateUnits: memo.raw.units, bfsEntries: memo.bfs.entries, bfsObstacleGroups: memo.bfs.groups.size,
      bfsKeyCharacters: memo.bfs.characters, bfsNumericUnits: memo.bfs.units };
  }

  _rawTerritoryUncached(
    friendlyNodes,
    friendlyLines,
    rawEnemyPoints,
    { requireClosedRegion = false, initialContour = null } = {},
  ) {
    const friendlyNodeKeys = new Set(friendlyNodes.map(pointKey));
    // The envelope proof relies on the native predecessor-DAG enumerator and
    // monotone flood fill. Keep subclass/diagnostic overrides on the old path.
    const usePathEnvelope = requireClosedRegion
      && NATIVE_TERRITORY_METHODS.every(([name, method]) => this[name] === method);
    // Existing overrides retain the pre-round-3 envelope and oracle call
    // order. Only the new bounds, persistent wall memo and scalar queries
    // require the stricter native dependency set.
    const useSharedValidation = usePathEnvelope
      && NATIVE_SHARED_TERRITORY_METHODS.every(([name, method]) => this[name] === method);
    const useScalarValidation = useSharedValidation;
    const enemyPoints = dedupePoints(rawEnemyPoints);
    const enemyKeySet = new Set(enemyPoints.map(pointKey));

    // 敌方点整数下标集，供 _bfsFromSource 热路径使用（避免字符串 key）
    const enemyIdxSet = new Set();
    for (const ep of enemyPoints) {
      const idx = this._keyToIdx.get(pointKey(ep));
      if (idx !== undefined) enemyIdxSet.add(idx);
    }

    // 阶段一：右手摸墙法获取外轮廓
    let currentPoly = initialContour
      ? initialContour.map(clonePoint)
      : this._getOuterContourFromPoints([...friendlyNodes, ...friendlyLines]);
    if (
      currentPoly.length < 3
      || (requireClosedRegion && !this._hasBoundaryCycle(currentPoly))
    ) {
      return { polygon: null, area: 0, displayArea: 0 };
    }

    let curArea = 0;
    // Enemy obstacles and board geometry are constant throughout this one
    // tightening pass, even as the contour changes. Do not retain this cache
    // across positions, players or canonical transformations.
    const bfsBySource = new Map();
    // A previously validated wall has fixed coverage and friendly/enemy
    // validity during this raw pass. If its perimeter is no worse than a
    // later identical wall, the monotonically improving incumbent already
    // dominates the later candidate; a shorter perimeter must still be tried.
    const sharedValidatedWallPerimeters = useSharedValidation ? new Map() : null;

    // 阶段二：动态贪心修剪（皮筋收紧）
    while (true) {
      const polyLen = currentPoly.length;
      if (polyLen < 3) break;
      // With no adjacent duplicate contour vertices, joining a simple shortest
      // path adds no adjacent duplicates. These are exact post-dedup lengths.
      // Custom/diagnostic contour or path behavior retains the original checks.
      const usePerimeterBounds = usePathEnvelope
        && currentPoly.every((point, index) => index === 0 || !pointEquals(point, currentPoly[index - 1]));

      // 每轮开始精确计算覆盖集：
      //   curCovered — 用于向内/向外捷径判定（.has(key) 查询）
      //   curArea    — 当前领土点数基准
      const curCovered = this._getCoveredPoints(currentPoly);
      curArea = curCovered.size;
      const curPerim = polyLen;

      let bestOverallCand = null;
      let bestCandPerim = curPerim;
      let bestCandArea = curArea;
      // Diagnostic or subclass oracles retain the original per-round scope.
      const validatedWallPerimeters = sharedValidatedWallPerimeters
        ?? (requireClosedRegion ? new Map() : null);

      const considerFullyValidatedCandidate = (rawCandidate) => {
        const candidate = rawCandidate.filter(
          (point, index) => index === 0 || !pointEquals(point, rawCandidate[index - 1]),
        );
        if (candidate.length < 3 || candidate.length > bestCandPerim) return;
        // Many predecessor-DAG paths describe the same flood-fill wall. Reuse
        // that equivalence without imposing an unsafe path-count cap.
        const wallKey = this._getWallSetKey(candidate);
        if (wallKey === null) return;
        const previousPerimeter = validatedWallPerimeters.get(wallKey);
        if (previousPerimeter !== undefined && previousPerimeter <= candidate.length) return;
        if (!this._hasBoundaryCycle(candidate)) return;
        validatedWallPerimeters.set(wallKey, candidate.length);
        const covered = useScalarValidation ? null : this._getCoveredPoints(candidate);
        const area = useScalarValidation
          ? this._getValidatedTerritoryArea(candidate, friendlyNodeKeys, enemyKeySet)
          : covered.size;
        if (area === null) return;
        if (candidate.length === bestCandPerim && area >= bestCandArea) return;
        if (!useScalarValidation && ![...friendlyNodeKeys].every((key) => covered.has(key))) return;
        if (!useScalarValidation && [...enemyKeySet].some((key) => covered.has(key))) return;
        bestCandPerim = candidate.length;
        bestCandArea = area;
        bestOverallCand = candidate;
      };

      // BFS 预计算：相同轮廓顶点可能在回折/自交 walk 中重复出现，按唯一
      // srcIdx 复用结果，避免对同一源点重复遍历全图。
      const bfsCache = new Array(polyLen);
      for (let i = 0; i < polyLen - 2; i += 1) {
        const srcIdx = this._keyToIdx.get(pointKey(currentPoly[i]));
        if (srcIdx !== undefined) {
          if (!bfsBySource.has(srcIdx)) {
            const bfs = this._bfsFromSource(srcIdx, enemyIdxSet);
            bfsBySource.set(srcIdx, {
              srcIdx, dist: bfs.dist, pred: bfs.pred,
              // These subproblems depend only on this source and the fixed
              // obstacle map, so all endpoint pairs and tightening rounds in
              // this one raw scoring pass can share them.
              paths: { counts: new Map([[srcIdx, 1]]) },
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
          const arcLen = j - i; // 弧段边数（轮廓逐格，每段恰好 1 格）
          const tgtIdx = this._keyToIdx.get(pointKey(currentPoly[j]));
          if (tgtIdx === undefined) continue;

          const shortestDist = distI[tgtIdx];
          // 剪枝：最短路 ≥ 弧段长度，无法缩短周长，跳过
          if (shortestDist === -1 || shortestDist >= arcLen) continue;

          // Every shortest-path wall is contained in its predecessor-DAG union.
          // Adding walls can only remove reachable water. If a friendly node is
          // still flooded with this superset, no path on that side can cover it.
          // This rejects impossible candidates without changing exact area,
          // path order, tie-breaking, or placing a cap on path enumeration.
          let possibleA = true, possibleB = true;
          const perimeterA = polyLen - arcLen + shortestDist;
          const perimeterB = arcLen + 1 + Math.max(0, shortestDist - 1);
          if (usePathEnvelope) {
            possibleA = !usePerimeterBounds || perimeterA <= bestCandPerim;
            possibleB = !usePerimeterBounds || perimeterB <= bestCandPerim;
            if (!possibleA && !possibleB) continue;
            const union = new Set([tgtIdx]), pending = [tgtIdx];
            for (let k = 0; k < pending.length; k++) {
              for (const previous of bfsCache[i].pred[pending[k]] || []) {
                if (!union.has(previous)) { union.add(previous); pending.push(previous); }
              }
            }
            const pathEnvelope = [...union].map(index => this.validPositions[index]);
            const couldCoverNodes = wall => {
              if (useSharedValidation) return this._coversFriendlyNodes(wall, friendlyNodeKeys);
              const covered = this._getCoveredPoints(wall);
              return [...friendlyNodeKeys].every(key => covered.has(key));
            };
            possibleA = possibleA && couldCoverNodes([...currentPoly.slice(0, i), ...pathEnvelope, ...currentPoly.slice(j + 1)]);
            possibleB = possibleB && couldCoverNodes([...currentPoly.slice(i, j + 1), ...pathEnvelope]);
            if (!possibleA && !possibleB) continue;
          }
          const possibleSides = () => (
            (possibleA && (!usePerimeterBounds || perimeterA <= bestCandPerim) ? 1 : 0)
            | (possibleB && (!usePerimeterBounds || perimeterB <= bestCandPerim) ? 2 : 0)
          );
          const paths = usePathEnvelope
            ? this._iterateCoveredTerritoryPaths(bfsCache[i], srcIdx, tgtIdx,
              [...currentPoly.slice(0, i), ...currentPoly.slice(j + 1)],
              currentPoly.slice(i, j + 1), friendlyNodeKeys, possibleSides,
              useSharedValidation ? bfsCache[i].paths : null,
              useSharedValidation && usePerimeterBounds ? side => (
                (side === 1 ? perimeterA : perimeterB) === bestCandPerim ? bestCandArea : Infinity
              ) : null)
            : this._iterateTerritoryPaths(bfsCache[i], srcIdx, tgtIdx);
          for (const path of paths) {
            if (usePerimeterBounds && !possibleSides()) break;
            // The generator emits ordinary path arrays. Only the private
            // raw-call context carries the side proof; diagnostics retain
            // the original array shape, and the live incumbent still wins.
            const candidateSides = useSharedValidation
              ? bfsCache[i].paths.emittedSides & possibleSides()
              : 3;
            const pathLen = path.length; // 顶点数（含两端点）
            const pathInterior = path.slice(1, -1); // 中间顶点（不含端点）

            // v2 deliberately validates both candidates with exact flood fill.
            // This removes the legacy inward shortcut's unproved assumption that
            // the current coverage already excludes every enemy element.
            if (requireClosedRegion) {
              const reversedMiddle = pathInterior.slice().reverse();
              if (possibleA && (candidateSides & 1)) considerFullyValidatedCandidate([
                ...currentPoly.slice(0, i),
                ...path,
                ...currentPoly.slice(j + 1),
              ]);
              if (possibleB && (candidateSides & 2)) considerFullyValidatedCandidate([
                ...currentPoly.slice(i, j + 1),
                ...reversedMiddle,
              ]);
              continue;
            }

            // ── 向内 / 向外捷径判定 ──────────────────────────────────────────────
            // 向内：所有中间顶点均在 curCovered 内（捷径在当前领土内部穿行）
            // 此条件满足时，楔形区域完全被当前领土包含，几何关系确定，
            // 可用代数公式计算 candA 面积，无需额外 flood-fill
            const isInward = pathInterior.every((p) => curCovered.has(pointKey(p)));

            if (isInward) {
              // ── 楔形优化：单次 flood-fill 同时服务 candA 和 candB ───────────────
              // wedge = 弧段 poly[i..j] + 路径逆向内部段（等价于旧代码的 candB）
              const revMid = pathInterior.slice().reverse();
              let wedge = [...currentPoly.slice(i, j + 1), ...revMid];
              wedge = wedge.filter((p, k) => k === 0 || !pointEquals(p, wedge[k - 1]));
              if (wedge.length < 3) continue;

              const wedgeCovered = this._getCoveredPoints(wedge);
              const wedgeArea = wedgeCovered.size;

              // 路径顶点 key 集合：路径边界上的友方节点在 candA 中仍属领土（豁免检查）
              const pathKeySet = new Set(path.map(pointKey));

              // ── 方案 A：用路径替换弧段 poly[i..j] ──────────────────────────────
              // 代数面积公式（精确整数，无需额外 flood-fill）：
              //   Δboundary = (pathLen-2) - (arcLen-1)   ← 路径内部 wall 替换弧段内部 wall
              //   W（楔形内部点数）= wedgeArea - (arcLen+1) - (pathLen-2)
              //   candA_area = curArea + Δboundary - W
              //              = curArea + (pathLen-arcLen-1) - (wedgeArea-arcLen-1-pathLen+2)
              //              = curArea - wedgeArea + 2*(pathLen-1)
              const candAArea = curArea - wedgeArea + 2 * (pathLen - 1);
              const candAPerim = curPerim - arcLen + (pathLen - 1);

              if (
                candAPerim <= bestCandPerim &&
                !(candAPerim === bestCandPerim && candAArea >= bestCandArea)
              ) {
                // 友方节点保护：楔形内部（不含路径 wall 点）不得含友方节点
                // 路径端点/内部点本身是 candA 的 wall，故 pathKeySet 内节点豁免
                const candANodeOk = [...friendlyNodeKeys].every(
                  (k) => !wedgeCovered.has(k) || pathKeySet.has(k),
                );
                // candA ⊆ cur 领土，敌方点已不在 cur 内，无需再查敌方
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

              // ── 方案 B（楔形）：以楔形取代整个当前多边形 ───────────────────────
              {
                const candBPerim = wedge.length; // = arcLen + pathLen - 1
                const candBArea = wedgeArea;
                if (
                  candBPerim <= bestCandPerim &&
                  !(candBPerim === bestCandPerim && candBArea >= bestCandArea)
                ) {
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
              // ── 回退：向外捷径，执行完整 flood-fill（两次）──────────────────────
              const revMid = pathInterior.slice().reverse();
              for (let cand of [
                [...currentPoly.slice(0, i), ...path, ...currentPoly.slice(j + 1)],
                [...currentPoly.slice(i, j + 1), ...revMid],
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
        // curArea 将在下轮循环顶部由 _getCoveredPoints 精确更新
      } else {
        break;
      }
    }

    if (
      currentPoly.length < 3
      || (requireClosedRegion && !this._hasBoundaryCycle(currentPoly))
    ) {
      return { polygon: null, area: 0, displayArea: 0 };
    }
    if (requireClosedRegion) {
      const finalCovered = this._getCoveredPoints(currentPoly);
      if ([...enemyKeySet].some((key) => finalCovered.has(key))) {
        return { polygon: null, area: 0, displayArea: 0 };
      }
      curArea = finalCovered.size;
    }
    const closedPoly = [...currentPoly, clonePoint(currentPoly[0])];
    return { polygon: closedPoly, area: curArea, displayArea: computeTriangularPolygonArea(currentPoly) };
  }

  _getCanonicalTerritoryTransforms(player) {
    // Extra seats have no default vertex. Their configured roots must never
    // invoke the six-seat default opening while rendering or scoring.
    if (this.playerCount > 6) return this.boardShape === "hexagon"
      ? [{ rotation: 0, reflected: false }, { rotation: 0, reflected: true }]
      : [BARYCENTRIC_TRANSFORMS.IDENTITY, BARYCENTRIC_TRANSFORMS.SWAP_XY];
    if (this.boardShape === "hexagon") {
      // Preserve the established seat-based scoring orientation when the
      // connectivity root is moved away from its original vertex.
      const vertexIndex = this.boardVertices.findIndex(
        (point) => pointEquals(point, buildInitialPositions(this.gridSize, this.playerCount, this.boardShape)[player]),
      );
      return [
        { rotation: -vertexIndex, reflected: false },
        { rotation: -vertexIndex, reflected: true },
      ];
    }
    if (this.playerCount === 2) {
      return player === Player.BLACK
        ? [BARYCENTRIC_TRANSFORMS.IDENTITY]
        : [BARYCENTRIC_TRANSFORMS.SWAP_XZ];
    }

    // Map each edge seat to the same reference edge and compare its two
    // orientations, just as corner seats use their two base orientations.
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
    const transform = (point) => isHexagon
      ? applyHexTransform(point, this.gridSize, permutation)
      : applyBarycentricTransform(point, this.gridSize, permutation);
    const friendlyNodes = this._getPlayerNodes(player).map(transform);
    const friendlyLines = this._getPlayerLines(player).map(transform);
    const enemyPoints = this._getOpponents(player).flatMap((opponent) => [
      ...this._getPlayerNodes(opponent).map(transform),
      ...this._getPlayerLines(opponent).map(transform),
    ]);
    const canonicalTerritory = this._computeRawTerritory(
      friendlyNodes,
      friendlyLines,
      enemyPoints,
      { requireClosedRegion: true },
    );
    const inverse = isHexagon ? null : invertPermutation(permutation);
    const polygon = canonicalTerritory.polygon
      ? canonicalTerritory.polygon.map(
          (point) => isHexagon
            ? applyHexTransform(point, this.gridSize, permutation, true)
            : applyBarycentricTransform(point, this.gridSize, inverse),
        )
      : null;
    return {
      canonicalKey: canonicalPolygonKey(canonicalTerritory.polygon),
      territory: { ...canonicalTerritory, polygon },
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
    const visited = new Set();
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
          const key = pointKey(neighbor);
          if (ownedKeys.has(key) || visited.has(key) || !covered.has(key)) continue;
          visited.add(key);
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
            ...this._getPlayerLines(opponent),
          ]),
          { initialContour: this._getOuterContour(player) },
        );
      case TerritoryRulesVersion.V2:
      case TerritoryRulesVersion.V3:
        break;
      default:
        throw new Error(`Unsupported territory rules version: ${this.rulesVersion}`);
    }

    const candidates = this._getCanonicalTerritoryTransforms(player)
      .map((permutation) => this._computeCanonicalTerritoryCandidate(player, permutation));
    candidates.sort((left, right) => (
      left.territory.area - right.territory.area
      || left.canonicalKey.localeCompare(right.canonicalKey)
    ));
    const territory = candidates[0].territory;
    if (this.rulesVersion === TerritoryRulesVersion.V2) return territory;

    // Keep v2's polygon for rendering, but compute the official v3 score from
    // all friendly walls so multiple enclosed components and holes are counted.
    const ownedPoints = [...this._getPlayerNodes(player), ...this._getPlayerLines(player)];
    const enemyPoints = this._getOpponents(player).flatMap((opponent) => [
      ...this._getPlayerNodes(opponent), ...this._getPlayerLines(opponent),
    ]);
    return {
      ...territory,
      area: this._computeOwnedWallArea(ownedPoints, enemyPoints),
      displayArea: territory.polygon ? territory.displayArea : ownedPoints.length,
    };
  }

  /** 将当前局面序列化为唯一字符串，用于 Superko 判断。
   *  包含：网格物理层（非空点）、逻辑拓扑层（各方边集合）、即将行棋方。 */
  _getStateHashOrder() {
    this._stateHashCoordinates ??= new Map();
    return [...this.grid.keys()].map(key => {
      if (!this._stateHashCoordinates.has(key)) {
        const [x, y] = key.split(",").map(Number);
        this._stateHashCoordinates.set(key, { key, x, y, cells: new Map() });
      }
      return this._stateHashCoordinates.get(key);
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

    const edgeLists = this.activePlayers.map((player) =>
      [...this._getEdges(player)].sort(),
    );

    const resignedPlayers = this.activePlayers.filter((player) => this.resignedPlayers.has(player));
    // Exactly the original JSON bytes, with cached cell serialization. Each
    // probe still checks the full board/edge/player hash against full history.
    return `[${JSON.stringify(nextPlayer)},${JSON.stringify(resignedPlayers)},[${gridEntries.join(",")}],${JSON.stringify(edgeLists)}]`;
  }

  _updateTerritories() {
    // Score queries happen often, so the cached result is refreshed in one place.
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

  _evaluateMove(point, player = this.currentPlayer, sourceNodes = null, hashOrder = undefined) {
    if (this.resignedPlayers.has(player)) {
      return { legal: false, reason: "PLAYER_RESIGNED", state: null, isAttack: false };
    }

    if (!this.isValidPosition(point)) {
      return { legal: false, reason: "INVALID_MOVE", state: null, isAttack: false };
    }

    const originalState = this._getState(point);
    const attackableLineStates = new Set(
      this._getOpponents(player).map((opponent) => this._getPlayerStates(opponent).line),
    );
    const isAttackingMove = attackableLineStates.has(originalState);
    const currentPlayerSnapshot = this.currentPlayer;
    const gridSnapshot = this.grid;
    const previousUndo = this._moveProbeUndo;
    const undo = new Map();
    const edgesSnapshot = Object.fromEntries(
      this.activePlayers.map((candidate) => [candidate, new Set(this._getEdges(candidate))]),
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
          isAttack: isAttackingMove,
        };
      }

      return { legal: true, reason: null, state: originalState, isAttack: isAttackingMove };
    } finally {
      this.grid = gridSnapshot;
      for (const [key, state] of undo) {
        if (state === undefined) this.grid.delete(key);
        else this.grid.set(key, state);
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
    // A probe restores the position in finally, so these source nodes remain
    // valid throughout this enumeration. No cross-position node cache.
    const sourceNodes = this._getPlayerNodes(player);
    const hashOrder = this._getStateHashOrder();
    for (const point of this.validPositions) {
      const evaluation = this._evaluateMove(point, player, sourceNodes, hashOrder);
      if (evaluation.legal) {
        result.push({
          point: clonePoint(point),
          state: evaluation.state,
          isAttack: evaluation.isAttack,
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
      this._getOpponents(this.currentPlayer).map((opponent) => this._getPlayerStates(opponent).line),
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
        } else if (
          this._getState(linePoint) === PointState.EMPTY ||
          this._getState(linePoint) === currentStates.line
        ) {
          this._setState(linePoint, currentStates.line);
        }
      }
      // 记录显式边
      this._getEdges(this.currentPlayer).add(this._edgeKey(point, node));
    }

    if (!connected) {
      this._setState(point, originalState);
      return false;
    }

    this._handleBlockingAttack(point, this.currentPlayer, originalState);
    // Blocking attacks only remove the opponent's nodes. Preserve the original
    // row-major crawl order, including the newly placed node.
    const crawlNodes = sourceNodes
      ? [...sourceNodes, point].sort((a, b) => a[1] - b[1] || a[0] - b[0]) : null;
    this._connectAllCrawl(this.currentPlayer, crawlNodes);
    if (isAttackingMove) {
      // Removing a blocking line/node can unlock any player's connections.
      // The attack's saved edges omit connections cut on earlier turns, so
      // rescan every other player's surviving nodes before the next move's
      // connectivity cleanup. Keep the acting player's existing priority.
      // Crawling only adds edges; one pass cannot unlock further connections.
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
      snapshot: this._isReplayingBatch ? null : this.getSnapshot(),
    };
  }

  _captureReplayState() {
    return {
      grid: new Map(this.grid),
      edges: Object.fromEntries(
        this.activePlayers.map((player) => [player, new Set(this._getEdges(player))]),
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
            polygon: territory.polygon ? territory.polygon.map(clonePoint) : null,
          }];
        }),
      ),
    };
  }

  _restoreReplayState(state) {
    this.grid = new Map(state.grid);
    this.edges = Object.fromEntries(
      this.activePlayers.map((player) => [player, new Set(state.edges[player])]),
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
          polygon: territory.polygon ? territory.polygon.map(clonePoint) : null,
        }];
      }),
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

    // Execute against an isolated transaction engine. A callback that returns
    // a Promise may already have queued more work by the time we can reject it;
    // keeping that work off the live engine preserves the synchronous contract.
    const transaction = new GameEngine({
      gridSize: this.gridSize,
      playerCount: this.playerCount,
      boardShape: this.boardShape,
      startPlayer: this.startPlayer,
      initialPositions: this.hasCustomInitialPositions ? this.initialPositions : undefined,
      rulesVersion: this.rulesVersion,
    });
    transaction._restoreReplayState(this._captureReplayState());

    let result;
    transaction._isReplayingBatch = true;
    try {
      result = callback(transaction);
      if (result && typeof result.then === "function") {
        // Consume a possible rejection so an explicitly rejected callback does
        // not also surface as an unrelated unhandled-rejection error.
        Promise.resolve(result).catch(() => {});
        throw new Error("replayBatch(callback) does not accept Promise results.");
      }
    } finally {
      transaction._isReplayingBatch = false;
    }

    if (!result || result.success !== true) {
      return {
        ...(result ?? {}),
        success: false,
        reason: result?.reason ?? "REPLAY_FAILED",
        snapshot: null,
      };
    }

    transaction._updateTerritories();
    const snapshot = transaction.getSnapshot();
    this._restoreReplayState(transaction._captureReplayState());
    return {
      ...result,
      snapshot,
    };
  }

  playMove(point) {
    if (this.gameOver) {
      return this._createActionResult(false, "GAME_OVER");
    }

    const normalizedPoint = clonePoint(point);

    // Superko 快照：在落子前保存完整状态，用于违规时回滚
    const gridSnapshot = new Map(this.grid);
    const edgesSnapshot = Object.fromEntries(
      this.activePlayers.map((player) => [player, new Set(this._getEdges(player))]),
    );

    const success = this._addNode(normalizedPoint);
    if (!success) {
      return this._createActionResult(false, "INVALID_MOVE");
    }

    // 结算后计算局面哈希（以对手为即将行棋方）
    const stateHash = this._computeStateHash(this._getNextPlayer(this.currentPlayer));

    if (this.historyHashes.has(stateHash)) {
      // 全局同形再现禁手：回滚所有变更，拒绝落子
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
      // Keep terminal scoring synchronous so winner/snapshot consumers never
      // observe a stale cache.  Non-terminal display scoring may be settled by
      // GameController's isolated TerritoryWorker on large boards.
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
    // The game ends when every active player skips once in a row.
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
}

// Capture native references once, so even prototype monkey-patches cannot
// accidentally activate the optimization for a different path/coverage oracle.
const NATIVE_TERRITORY_METHODS = Object.freeze([
  '_bfsFromSource', '_reconstructPaths', '_iterateReconstructedPaths',
  '_iterateTerritoryPaths', '_iterateCoveredTerritoryPaths', '_getCoveredPoints',
].map(name => [name, GameEngine.prototype[name]]));
const NATIVE_SHARED_TERRITORY_METHODS = Object.freeze([
  '_pointToIndex', '_getWallSetKey', '_getOuterContourFromPoints', '_hasBoundaryCycle',
  '_territoryBfsUncached', '_coversFriendlyNodes', '_getValidatedTerritoryArea',
].map(name => [name, GameEngine.prototype[name]]));
const NATIVE_FLOOD_COVERAGE = GameEngine.prototype._getCoveredPoints;
const NATIVE_FLOOD_POINT_INDEX = GameEngine.prototype._pointToIndex;

// The memo survives undo/restore because every hit validates its dependencies.
// Weak ownership excludes it from snapshots and lets temporary AI engines die.
const TERRITORY_DEPENDENCY_MEMOS = new WeakMap();
const NATIVE_DEPENDENCY_METHODS = Object.freeze([
  '_pointToIndex', '_getWallSetKey', '_getOuterContourFromPoints', '_hasBoundaryCycle',
  '_getCoveredPoints', '_bfsFromSource', '_territoryBfsUncached', '_rawTerritoryUncached',
  '_coversFriendlyNodes', '_getValidatedTerritoryArea',
  '_reconstructPaths', '_iterateReconstructedPaths', '_iterateTerritoryPaths', '_iterateCoveredTerritoryPaths',
].map(name => [name, GameEngine.prototype[name]]));

function dependencyBucket(maxCharacters, maxUnits) {
  return { entries: new Map(), characters: 0, units: 0, maxCharacters, maxUnits };
}
function dependencyMemo(engine) {
  if (!TERRITORY_DEPENDENCY_MEMOS.has(engine)) TERRITORY_DEPENDENCY_MEMOS.set(engine, {
    geometry: null, context: null, raw: dependencyBucket(131072, 16384), bfs: dependencyBfsBucket(),
    stats: { rawHits: 0, rawMisses: 0, bfsExactHits: 0, bfsDependencyHits: 0, bfsMisses: 0, geometryChanges: 0 },
  });
  return TERRITORY_DEPENDENCY_MEMOS.get(engine);
}
function updateDependencyGeometry(engine, memo) {
  // Include actual ordered topology, not just board size or object identity.
  const geometry = JSON.stringify([engine.gridSize, engine.boardShape, engine.validPositions,
    engine._adjIdxList, engine._boundaryIdxs, [...engine._keyToIdx], engine._rowIndexOffsets,
    engine._rowIndexGridSize, engine._rowIndexBoardShape, engine._wallKeyWordCount]);
  if (geometry !== memo.geometry) {
    if (memo.geometry !== null) memo.stats.geometryChanges++;
    memo.geometry = geometry;
    memo.raw = dependencyBucket(131072, 16384);
    memo.bfs = dependencyBfsBucket();
  }
}
function dependencyGet(bucket, key) {
  const record = bucket.entries.get(key);
  if (!record) return null;
  bucket.entries.delete(key); bucket.entries.set(key, record);
  return record.value;
}
function dependencyPut(bucket, key, value, units) {
  if (key.length > bucket.maxCharacters || units > bucket.maxUnits) return;
  while (bucket.entries.size >= 64 || bucket.characters + key.length > bucket.maxCharacters || bucket.units + units > bucket.maxUnits) {
    const [oldKey, record] = bucket.entries.entries().next().value;
    bucket.entries.delete(oldKey); bucket.characters -= oldKey.length; bucket.units -= record.units;
  }
  bucket.entries.set(key, { value, units }); bucket.characters += key.length; bucket.units += units;
}
function dependencyPointsKey(points) {
  if (!Array.isArray(points) || Object.getPrototypeOf(points) !== Array.prototype || points.length > 4096
    || points.map !== Array.prototype.map || points[Symbol.iterator] !== Array.prototype[Symbol.iterator]) return null;
  const parts = [];
  for (let index = 0; index < points.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(points, String(index));
    if (!descriptor || !('value' in descriptor)) return null;
    const point = descriptor.value;
    if (!Array.isArray(point) || point.length !== 2) return null;
    const x = Object.getOwnPropertyDescriptor(point, '0'), y = Object.getOwnPropertyDescriptor(point, '1');
    if (!x || !y || !('value' in x) || !('value' in y)
      || !Number.isSafeInteger(x.value) || !Number.isSafeInteger(y.value)
      || Object.is(x.value, -0) || Object.is(y.value, -0)) return null;
    parts.push(`${x.value},${y.value}`);
  }
  return parts.join(';');
}
function copyDependencyTerritory(result) {
  return { ...result, polygon: result.polygon ? result.polygon.map(clonePoint) : null };
}
function dependencyBfsBucket() {
  return { groups: new Map(), entries: 0, characters: 0, units: 0 };
}
function dependencyBfsGet(bucket, obstacleKey, srcIdx) {
  const group = bucket.groups.get(obstacleKey);
  if (!group) return null;
  bucket.groups.delete(obstacleKey); bucket.groups.set(obstacleKey, group);
  return group.entries.get(srcIdx) || null;
}
function dependencyBfsPut(bucket, obstacleKey, srcIdx, entry) {
  if (obstacleKey.length > 65536 || entry.units > 524288) return;
  let group = bucket.groups.get(obstacleKey);
  // Admission preserves the first six sources for each obstacle view instead
  // of evicting them during a sequential contour scan. Twelve complete enemy
  // views cover the two canonical orientations of six active players.
  if (group?.entries.has(srcIdx) || (group && group.entries.size >= 6)) return;
  while ((!group && bucket.groups.size >= 12) || bucket.characters + (group ? 0 : obstacleKey.length) > 65536
    || bucket.units + entry.units > 524288) {
    const [key, removed] = bucket.groups.entries().next().value;
    bucket.groups.delete(key); bucket.characters -= key.length;
    bucket.entries -= removed.entries.size; bucket.units -= removed.units;
    if (key === obstacleKey) group = null;
  }
  if (!group) {
    group = { entries: new Map(), units: 0 };
    bucket.groups.set(obstacleKey, group); bucket.characters += obstacleKey.length;
  }
  group.entries.set(srcIdx, entry); group.units += entry.units;
  bucket.entries++; bucket.units += entry.units;
}
function packDependencyBfs(result) {
  const offsets = new Int32Array(result.pred.length + 1);
  for (let index = 0; index < result.pred.length; index++) offsets[index + 1] = offsets[index] + (result.pred[index]?.length || 0);
  const predecessors = new Int32Array(offsets[offsets.length - 1]);
  for (let index = 0; index < result.pred.length; index++) if (result.pred[index]) predecessors.set(result.pred[index], offsets[index]);
  return { dist: new Int32Array(result.dist), offsets, predecessors };
}
function unpackDependencyBfs(result) {
  // Never expose retained typed arrays or iterator-specific extra metadata.
  return { dist: new Int32Array(result.dist), pred: Array.from({length:result.dist.length}, (_, index) =>
    result.offsets[index + 1] > result.offsets[index]
      ? Array.from(result.predecessors.subarray(result.offsets[index], result.offsets[index + 1])) : null) };
}

export default GameEngine;
