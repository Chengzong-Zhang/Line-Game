const DEFAULT_GRID_SIZE = 9;
const MIN_GRID_SIZE = 5;
const MAX_GRID_SIZE = 15;

// GameEngine 鍙叧蹇冭鍒欑姸鎬侊紝涓嶅叧蹇?Canvas銆乂ue 鎴?WebSocket銆?// 鍙屼汉/涓変汉妯″紡鐨勫樊寮備富瑕佷綋鐜板湪鐜╁鏋氫妇銆佸垵濮嬭惤鐐瑰拰杞崲椤哄簭涓婏紝
// 杈圭晫銆侀潰绉€佺鎾炵瓑鍑犱綍閫昏緫灏介噺淇濇寔涓庣帺瀹舵暟閲忚В鑰︺€?
export const Player = Object.freeze({
  BLACK: "BLACK",
  WHITE: "WHITE",
  PURPLE: "PURPLE",
});

export const PointState = Object.freeze({
  EMPTY: 0,
  BLACK_NODE: 1,
  BLACK_LINE: 2,
  WHITE_NODE: 3,
  WHITE_LINE: 4,
  PURPLE_NODE: 5,
  PURPLE_LINE: 6,
});

const PLAYER_ORDER = [Player.BLACK, Player.WHITE, Player.PURPLE];
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
});

function buildInitialPositions(gridSize, playerCount) {
  // Three-player mode starts from the three corners to keep opening pressure balanced.
  if (playerCount === 2) {
    return Object.freeze({
      [Player.BLACK]: Object.freeze([0, 0]),
      [Player.WHITE]: Object.freeze([gridSize - 1, 0]),
    });
  }

  return Object.freeze({
    [Player.BLACK]: Object.freeze([0, 0]),
    [Player.WHITE]: Object.freeze([0, gridSize - 1]),
    [Player.PURPLE]: Object.freeze([gridSize - 1, 0]),
  });
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


export class GameEngine {
  constructor(options = {}) {
    this.gridSize = options.gridSize ?? DEFAULT_GRID_SIZE;
    if (!Number.isInteger(this.gridSize) || this.gridSize < MIN_GRID_SIZE || this.gridSize > MAX_GRID_SIZE) {
      throw new Error(`gridSize must be an integer between ${MIN_GRID_SIZE} and ${MAX_GRID_SIZE}.`);
    }
    this.playerCount = options.playerCount ?? 2;
    if (this.playerCount !== 2 && this.playerCount !== 3) {
      throw new Error("Only 2-player and 3-player modes are supported.");
    }
    // activePlayers is the single source of truth for turn order and rules.
    this.activePlayers = PLAYER_ORDER.slice(0, this.playerCount);
    this.initialPositions = buildInitialPositions(this.gridSize, this.playerCount);
    this.startPlayer = this.activePlayers.includes(options.startPlayer) ? options.startPlayer : this.activePlayers[0];

    this.validPositions = [];
    this.positionKeys = new Set();
    this.grid = new Map();
    this.currentPlayer = this.startPlayer;
    this.gameOver = false;
    this.consecutiveSkips = 0;
    this.turnCount = 0;
    this.cachedTerritories = Object.fromEntries(
      this.activePlayers.map((player) => [player, { polygon: null, area: 0 }]),
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
    this._updateTerritories();

    // 将初始局面写入历史，防止任何操作回到起始状态
    this.historyHashes.add(this._computeStateHash(this.startPlayer));
  }

  _initGrid() {
    for (let y = 0; y < this.gridSize; y += 1) {
      for (let x = 0; x < this.gridSize - y; x += 1) {
        const point = [x, y];
        const key = pointKey(point);
        this.validPositions.push(point);
        this.positionKeys.add(key);
        this.grid.set(key, PointState.EMPTY);
      }
    }
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
    this.grid.set(pointKey(point), state);
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
    for (let y = 0; y < this.gridSize; y += 1) {
      const row = [];
      for (let x = 0; x < this.gridSize; x += 1) {
        row.push(this.isValidPosition([x, y]) ? this._getState([x, y]) : null);
      }
      matrix.push(row);
    }
    return matrix;
  }

  getScoreboard() {
    return Object.fromEntries(
      this.activePlayers.map((player) => [player, { ...this.cachedTerritories[player] }]),
    );
  }

  getSnapshot() {
    // Snapshot is the read-only view consumed by the UI and network sync.
    const scores = this.getScoreboard();
    const territories = Object.fromEntries(
      this.activePlayers.map((player) => [
        player,
        {
          area: scores[player].area,
          polygon: scores[player].polygon ? scores[player].polygon.map(clonePoint) : null,
        },
      ]),
    );
    const edges = Object.fromEntries(
      this.activePlayers.map((player) => [
        player,
        [...this._getEdges(player)],
      ]),
    );
    return {
      gridSize: this.gridSize,
      playerCount: this.playerCount,
      players: [...this.activePlayers],
      startPlayer: this.startPlayer,
      currentPlayer: this.currentPlayer,
      gameOver: this.gameOver,
      consecutiveSkips: this.consecutiveSkips,
      turnCount: this.turnCount,
      boardMatrix: this.getBoardMatrix(),
      territories,
      edges,
      winner: this.getWinner(),
      legalMoves: this.getLegalMoves(this.currentPlayer),
    };
  }

  getWinner() {
    if (!this.gameOver) {
      return null;
    }

    let winner = null;
    let bestArea = Number.NEGATIVE_INFINITY;
    let isDraw = false;

    for (const player of this.activePlayers) {
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

    for (const point of linePoints) {
      if (pointEquals(point, pointA) || pointEquals(point, pointB)) {
        continue;
      }
      const state = this._getState(point);
      for (const opponent of this._getOpponents(player)) {
        const opponentStates = this._getPlayerStates(opponent);
        if (state === opponentStates.node || state === opponentStates.line) {
          return false;
        }
      }
    }
    return true;
  }

  _checkThreePointLimitation(newPoint, player) {
    const currentNodes = this._getPlayerNodes(player);
    const nodeKeys = new Set(currentNodes.map(pointKey));
    const adjacentNodes = this.getAdjacentPositions(newPoint).filter((point) => nodeKeys.has(pointKey(point)));

    if (adjacentNodes.length >= 2) {
      return false;
    }

    for (const adjacentNode of adjacentNodes) {
      const adjacentExistingNodes = this.getAdjacentPositions(adjacentNode).filter((point) => nodeKeys.has(pointKey(point)));
      if (adjacentExistingNodes.length >= 1) {
        return false;
      }
    }

    return true;
  }

  _isInProtectionZone(point, player) {
    return this._getOpponents(player).some((opponent) => {
      const protectedPoints = this.getAdjacentPositions(this._getInitialPosition(opponent));
      return protectedPoints.some((protectedPoint) => pointEquals(protectedPoint, point));
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

  _reconnectPlayerNodes(player) {
    const playerNodes = this._getPlayerNodes(player);
    const { node: nodeState, line: lineState } = this._getPlayerStates(player);

    for (let i = 0; i < playerNodes.length; i += 1) {
      for (let j = i + 1; j < playerNodes.length; j += 1) {
        const nodeA = playerNodes[i];
        const nodeB = playerNodes[j];
        if (!this.canConnectWithBlocking(nodeA, nodeB, player)) {
          continue;
        }

        const linePoints = this.getLinePoints(nodeA, nodeB);
        for (const point of linePoints) {
          if (pointEquals(point, nodeA) || pointEquals(point, nodeB)) {
            this._setState(point, nodeState);
          } else if (this._getState(point) === PointState.EMPTY) {
            this._setState(point, lineState);
          }
        }
        // 记录显式边
        this._getEdges(player).add(this._edgeKey(nodeA, nodeB));
      }
    }
  }

  _handleBlockingAttack(newPoint, player, originalState) {
    const opponent = this._getPlayerByLineState(originalState);
    if (!opponent || opponent === player) {
      return;
    }
    const opponentStates = this._getPlayerStates(opponent);

    const [x0, y0] = newPoint;
    for (const [dx, dy] of DIRECTIONS) {
      let x = x0 + dx;
      let y = y0 + dy;
      const firstStep = [x, y];
      if (!this.isValidPosition(firstStep) || this._getState(firstStep) !== opponentStates.line) {
        continue;
      }

      const cellsToDelete = [];
      while (this.isValidPosition([x, y]) && this._getState([x, y]) === opponentStates.line) {
        cellsToDelete.push([x, y]);
        x += dx;
        y += dy;
      }

      const stoppingPoint = [x, y];
      if (this.isValidPosition(stoppingPoint) && this._getState(stoppingPoint) === opponentStates.node) {
        for (const cell of cellsToDelete) {
          this._setState(cell, PointState.EMPTY);
        }
      }
    }

    // Step 1.5: 清理因线点删除而断裂的对手边
    this._cleanupBrokenEdges(opponent);

    const opponentStart = this._getInitialPosition(opponent);
    for (const node of this._getPlayerNodes(opponent)) {
      if (pointEquals(node, opponentStart)) {
        continue;
      }
      if (!this._isConnectedToInitial(node, opponent)) {
        this._setState(node, PointState.EMPTY);
        this._removeNodeEdges(node, opponent); // 移除该孤立节点的所有边
      }
    }

    const survivingNodes = this._getPlayerNodes(opponent);
    for (const linePoint of this.validPositions) {
      if (this._getState(linePoint) !== opponentStates.line) {
        continue;
      }

      let protectedLine = false;
      for (let i = 0; i < survivingNodes.length && !protectedLine; i += 1) {
        for (let j = i + 1; j < survivingNodes.length; j += 1) {
          const nodeA = survivingNodes[i];
          const nodeB = survivingNodes[j];
          if (!this.canConnect(nodeA, nodeB)) {
            continue;
          }
          const segment = this.getLinePoints(nodeA, nodeB);
          const containsLinePoint = segment.some((point) => pointEquals(point, linePoint));
          if (!containsLinePoint) {
            continue;
          }

          const segmentIntact = segment.every((point) => {
            const state = this._getState(point);
            return state === opponentStates.node || state === opponentStates.line;
          });
          if (segmentIntact) {
            protectedLine = true;
            break;
          }
        }
      }

      if (!protectedLine) {
        this._setState(linePoint, PointState.EMPTY);
      }
    }

    this._reconnectPlayerNodes(player);
    this._reconnectPlayerNodes(opponent);
  }

  getAllShortestGridPaths(start, end, blockedPoints = []) {
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
    const distances = new Map([[startKey, 0]]);
    const predecessors = new Map();

    while (queue.length > 0) {
      const current = queue.shift();
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
    const friendlySet = new Set();
    for (const p of [...this._getPlayerNodes(player), ...this._getPlayerLines(player)]) {
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

  /** 阶段三：泛洪法领土判定 — 从边缘注水，未被淹没即为领土 */
  _getCoveredPoints(polygon) {
    const wallSet = new Set(polygon.map(pointKey));
    const waterReached = new Set();
    const queue = [];
    let qi = 0;

    // 从三条物理边缘注水（x==0, y==0, x+y==gridSize-1）
    for (let y = 0; y < this.gridSize; y += 1) {
      for (let x = 0; x < this.gridSize - y; x += 1) {
        if (x === 0 || y === 0 || x + y === this.gridSize - 1) {
          const k = pointKey([x, y]);
          if (!wallSet.has(k)) {
            waterReached.add(k);
            queue.push([x, y]);
          }
        }
      }
    }

    while (qi < queue.length) {
      const curr = queue[qi];
      qi += 1;
      for (const nxt of this.getAdjacentPositions(curr)) {
        const k = pointKey(nxt);
        if (!wallSet.has(k) && !waterReached.has(k)) {
          waterReached.add(k);
          queue.push(nxt);
        }
      }
    }

    // 领土 = 全图所有点 - 被水淹没的点（含轮廓墙体本身）
    const covered = new Set();
    for (const p of this.validPositions) {
      const k = pointKey(p);
      if (!waterReached.has(k)) {
        covered.add(k);
      }
    }
    return covered;
  }

  /** 核心领土计算：右手摸墙 → 动态贪心修剪 → 泛洪法 */
  _computeTerritory(player) {
    const friendlyNodeKeys = new Set(this._getPlayerNodes(player).map(pointKey));
    const enemyPoints = dedupePoints(
      this._getOpponents(player).flatMap((opp) => [
        ...this._getPlayerNodes(opp),
        ...this._getPlayerLines(opp),
      ]),
    );
    const enemyKeySet = new Set(enemyPoints.map(pointKey));

    // 阶段一：右手摸墙法获取外轮廓
    let currentPoly = this._getOuterContour(player);
    if (currentPoly.length < 3) {
      return { polygon: null, area: 0 };
    }

    // 阶段二：动态贪心修剪（皮筋收紧）
    while (true) {
      const n = currentPoly.length;
      if (n < 3) break;

      const curPerim = n;
      const curArea = this._getCoveredPoints(currentPoly).size;

      let bestOverallCand = null;
      let bestCandPerim = curPerim;
      let bestCandArea = curArea;

      for (let i = 0; i < n; i += 1) {
        for (let j = n - 1; j > i + 1; j -= 1) {
          const paths = this.getAllShortestGridPaths(currentPoly[i], currentPoly[j], enemyPoints);
          if (!paths || paths.length === 0) continue;

          for (const path of paths) {
            // 方案 A：用路径替换 poly[i..j] 段
            const candA = [...currentPoly.slice(0, i), ...path, ...currentPoly.slice(j + 1)];
            // 方案 B：用反向路径中间段替换互补弧
            const revMid = path.slice(1, -1).reverse();
            const candB = [...currentPoly.slice(i, j + 1), ...revMid];

            for (let cand of [candA, candB]) {
              // 去除相邻重复顶点
              cand = cand.filter((p, k) => k === 0 || !pointEquals(p, cand[k - 1]));
              if (cand.length < 3) continue;

              const candPerim = cand.length;
              if (candPerim > bestCandPerim) continue;

              // 泛洪法计算真实领土
              const covered = this._getCoveredPoints(cand);
              const candArea = covered.size;

              // 周长相等时领土点数没有更小，淘汰
              if (candPerim === bestCandPerim && candArea >= bestCandArea) continue;

              // 核心资产保护：所有友方节点必须在领土内
              if (![...friendlyNodeKeys].every((k) => covered.has(k))) continue;

              // 避障测试：领土内不得包含任何敌方点
              if ([...enemyKeySet].some((k) => covered.has(k))) continue;

              bestCandPerim = candPerim;
              bestCandArea = candArea;
              bestOverallCand = cand;
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

    if (currentPoly.length < 3) {
      return { polygon: null, area: 0 };
    }

    // 阶段三：泛洪法计算最终领土面积
    const finalCovered = this._getCoveredPoints(currentPoly);
    const area = finalCovered.size;

    // 首尾闭合，供渲染使用
    const closedPoly = [...currentPoly, clonePoint(currentPoly[0])];
    return { polygon: closedPoly, area };
  }

  /** 将当前局面序列化为唯一字符串，用于 Superko 判断。
   *  包含：网格物理层（非空点）、逻辑拓扑层（各方边集合）、即将行棋方。 */
  _computeStateHash(nextPlayer) {
    const gridEntries = [];
    for (const [key, state] of this.grid.entries()) {
      if (state !== PointState.EMPTY) {
        const [x, y] = key.split(",").map(Number);
        gridEntries.push([x, y, state]);
      }
    }
    gridEntries.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    const edgeLists = this.activePlayers.map((player) =>
      [...this._getEdges(player)].sort(),
    );

    return JSON.stringify([nextPlayer, gridEntries, edgeLists]);
  }

  _updateTerritories() {
    // Score queries happen often, so the cached result is refreshed in one place.
    for (const player of this.activePlayers) {
      this.cachedTerritories[player] = this._computeTerritory(player);
    }
  }

  _switchPlayer() {
    const currentIndex = this.activePlayers.indexOf(this.currentPlayer);
    this.currentPlayer = this.activePlayers[(currentIndex + 1) % this.activePlayers.length];
  }

  _hasValidMoves(player) {
    const existingNodes = this._getPlayerNodes(player);
    const attackableLineStates = new Set(
      this._getOpponents(player).map((opponent) => this._getPlayerStates(opponent).line),
    );
    const occupiableLineStates = new Set(this.activePlayers.map((candidate) => this._getPlayerStates(candidate).line));

    for (const point of this.validPositions) {
      const state = this._getState(point);
      if (state !== PointState.EMPTY && !occupiableLineStates.has(state)) {
        continue;
      }

      if (this._isInProtectionZone(point, player)) {
        continue;
      }

      const isAttackingMove = attackableLineStates.has(state);
      if (!isAttackingMove && !this._checkThreePointLimitation(point, player)) {
        continue;
      }

      for (const node of existingNodes) {
        if (!pointEquals(node, point) && this.canConnectWithBlocking(point, node, player)) {
          return true;
        }
      }
    }

    return false;
  }

  getLegalMoves(player = this.currentPlayer) {
    const existingNodes = this._getPlayerNodes(player);
    const attackableLineStates = new Set(
      this._getOpponents(player).map((opponent) => this._getPlayerStates(opponent).line),
    );
    const occupiableLineStates = new Set(this.activePlayers.map((candidate) => this._getPlayerStates(candidate).line));
    const result = [];

    for (const point of this.validPositions) {
      const state = this._getState(point);
      if (state !== PointState.EMPTY && !occupiableLineStates.has(state)) {
        continue;
      }

      if (this._isInProtectionZone(point, player)) {
        continue;
      }

      const isAttackingMove = attackableLineStates.has(state);
      if (!isAttackingMove && !this._checkThreePointLimitation(point, player)) {
        continue;
      }

      const connects = existingNodes.some((node) => !pointEquals(node, point) && this.canConnectWithBlocking(point, node, player));
      if (connects) {
        result.push({
          point: clonePoint(point),
          state,
          isAttack: isAttackingMove,
        });
      }
    }

    return result;
  }

  _checkAndAutoSkip() {
    if (this.gameOver) {
      return;
    }

    if (!this._hasValidMoves(this.currentPlayer)) {
      this.consecutiveSkips += 1;
      if (this.consecutiveSkips >= this.activePlayers.length) {
        this.gameOver = true;
      } else {
        this._switchPlayer();
        this._checkAndAutoSkip();
      }
    }
  }

  _addNode(point) {
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

    const existingNodes = this._getPlayerNodes(this.currentPlayer).filter((node) => !pointEquals(node, point));
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
    return true;
  }

  playMove(point) {
    if (this.gameOver) {
      return {
        success: false,
        reason: "GAME_OVER",
        snapshot: this.getSnapshot(),
      };
    }

    const normalizedPoint = clonePoint(point);

    // Superko 快照：在落子前保存完整状态，用于违规时回滚
    const gridSnapshot = new Map(this.grid);
    const edgesSnapshot = Object.fromEntries(
      this.activePlayers.map((player) => [player, new Set(this._getEdges(player))]),
    );

    const success = this._addNode(normalizedPoint);
    if (!success) {
      return {
        success: false,
        reason: "INVALID_MOVE",
        snapshot: this.getSnapshot(),
      };
    }

    // 结算后计算局面哈希（以对手为即将行棋方）
    const currentIndex = this.activePlayers.indexOf(this.currentPlayer);
    const nextPlayer = this.activePlayers[(currentIndex + 1) % this.activePlayers.length];
    const stateHash = this._computeStateHash(nextPlayer);

    if (this.historyHashes.has(stateHash)) {
      // 全局同形再现禁手：回滚所有变更，拒绝落子
      this.grid = gridSnapshot;
      for (const player of this.activePlayers) {
        this.edges[player] = edgesSnapshot[player];
      }
      return {
        success: false,
        reason: "SUPERKO_VIOLATION",
        snapshot: this.getSnapshot(),
      };
    }

    this.historyHashes.add(stateHash);
    this.turnCount += 1;
    this.consecutiveSkips = 0;
    this._switchPlayer();
    this._checkAndAutoSkip();
    this._updateTerritories();

    return {
      success: true,
      reason: null,
      snapshot: this.getSnapshot(),
    };
  }

  skipTurn() {
    if (this.gameOver) {
      return {
        success: false,
        reason: "GAME_OVER",
        snapshot: this.getSnapshot(),
      };
    }

    this.consecutiveSkips += 1;
    // The game ends when every active player skips once in a row.
    if (this.consecutiveSkips >= this.activePlayers.length) {
      this.gameOver = true;
    } else {
      this._switchPlayer();
      this._checkAndAutoSkip();
    }

    this._updateTerritories();
    return {
      success: true,
      reason: null,
      snapshot: this.getSnapshot(),
    };
  }
}

export default GameEngine;
