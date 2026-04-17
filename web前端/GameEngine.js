const GRID_SIZE = 9;

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

const INITIAL_POSITIONS = Object.freeze({
  [Player.BLACK]: Object.freeze([0, 0]),
  [Player.WHITE]: Object.freeze([0, 8]),
  [Player.PURPLE]: Object.freeze([8, 0]),
});

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

function cartesianProduct(arrays) {
  if (arrays.length === 0) {
    return [[]];
  }

  let result = [[]];
  for (const array of arrays) {
    const next = [];
    for (const prefix of result) {
      for (const value of array) {
        next.push(prefix.concat([value]));
      }
    }
    result = next;
  }
  return result;
}

function buildConvexHull(points) {
  const unique = dedupePoints(points).sort((a, b) => {
    if (a[0] !== b[0]) {
      return a[0] - b[0];
    }
    return a[1] - b[1];
  });

  if (unique.length <= 1) {
    return unique;
  }

  const lower = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper = [];
  for (let i = unique.length - 1; i >= 0; i -= 1) {
    const point = unique[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export class GameEngine {
  constructor(options = {}) {
    this.gridSize = options.gridSize ?? GRID_SIZE;
    if (this.gridSize !== GRID_SIZE) {
      throw new Error("Only a 9x9 triangular grid is currently supported.");
    }
    this.playerCount = options.playerCount ?? 2;
    if (this.playerCount !== 2 && this.playerCount !== 3) {
      throw new Error("Only 2-player and 3-player modes are supported.");
    }
    this.activePlayers = PLAYER_ORDER.slice(0, this.playerCount);

    this.validPositions = [];
    this.positionKeys = new Set();
    this.grid = new Map();
    this.currentPlayer = this.activePlayers[0];
    this.gameOver = false;
    this.consecutiveSkips = 0;
    this.turnCount = 0;
    this.cachedTerritories = Object.fromEntries(
      this.activePlayers.map((player) => [player, { polygon: null, area: 0 }]),
    );

    this._initGrid();
    for (const player of this.activePlayers) {
      this._setState(INITIAL_POSITIONS[player], this._getPlayerStates(player).node);
    }
    this._updateTerritories();
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
    return clonePoint(INITIAL_POSITIONS[player]);
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
    return {
      gridSize: this.gridSize,
      playerCount: this.playerCount,
      players: [...this.activePlayers],
      currentPlayer: this.currentPlayer,
      gameOver: this.gameOver,
      consecutiveSkips: this.consecutiveSkips,
      turnCount: this.turnCount,
      boardMatrix: this.getBoardMatrix(),
      territories,
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

  _isConnectedToInitial(point, player) {
    const initial = this._getInitialPosition(player);
    const visited = new Set();
    const stack = [initial];
    const { node: nodeState, line: lineState } = this._getPlayerStates(player);

    while (stack.length > 0) {
      const current = stack.pop();
      const currentKey = pointKey(current);
      if (pointEquals(current, point)) {
        return true;
      }
      if (visited.has(currentKey)) {
        continue;
      }
      visited.add(currentKey);

      for (const candidate of this.validPositions) {
        const candidateKey = pointKey(candidate);
        const state = this._getState(candidate);
        if (visited.has(candidateKey)) {
          continue;
        }
        if (state !== nodeState && state !== lineState) {
          continue;
        }
        if (!this.canConnectWithBlocking(current, candidate, player)) {
          continue;
        }

        const linePoints = this.getLinePoints(current, candidate);
        const lineIntact = linePoints.every((segmentPoint) => {
          const segmentState = this._getState(segmentPoint);
          return segmentState === nodeState || segmentState === lineState;
        });
        if (lineIntact) {
          stack.push(candidate);
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

    const opponentStart = this._getInitialPosition(opponent);
    for (const node of this._getPlayerNodes(opponent)) {
      if (pointEquals(node, opponentStart)) {
        continue;
      }
      if (!this._isConnectedToInitial(node, opponent)) {
        this._setState(node, PointState.EMPTY);
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

  _isOnSegment(point, segmentStart, segmentEnd) {
    const areaTwice =
      (point[1] - segmentStart[1]) * (segmentEnd[0] - segmentStart[0]) -
      (point[0] - segmentStart[0]) * (segmentEnd[1] - segmentStart[1]);
    if (areaTwice !== 0) {
      return false;
    }

    return (
      point[0] >= Math.min(segmentStart[0], segmentEnd[0]) &&
      point[0] <= Math.max(segmentStart[0], segmentEnd[0]) &&
      point[1] >= Math.min(segmentStart[1], segmentEnd[1]) &&
      point[1] <= Math.max(segmentStart[1], segmentEnd[1])
    );
  }

  _polygonContainsAll(polygon, friendlyPoints) {
    if (!polygon || polygon.length < 3) {
      return false;
    }

    for (const point of friendlyPoints) {
      if (polygon.some((polygonPoint) => pointEquals(polygonPoint, point))) {
        continue;
      }

      let onBoundary = false;
      for (let i = 0; i < polygon.length; i += 1) {
        const start = polygon[i];
        const end = polygon[(i + 1) % polygon.length];
        if (this._isOnSegment(point, start, end)) {
          onBoundary = true;
          break;
        }
      }
      if (onBoundary) {
        continue;
      }

      const [x, y] = point;
      let inside = false;
      let [p1x, p1y] = polygon[0];
      for (let i = 1; i <= polygon.length; i += 1) {
        const [p2x, p2y] = polygon[i % polygon.length];
        if (y > Math.min(p1y, p2y)) {
          if (y <= Math.max(p1y, p2y) && x <= Math.max(p1x, p2x)) {
            let xIntersections = Infinity;
            if (p1y !== p2y) {
              xIntersections = ((y - p1y) * (p2x - p1x)) / (p2y - p1y) + p1x;
            }
            if (p1x === p2x || x <= xIntersections) {
              inside = !inside;
            }
          }
        }
        p1x = p2x;
        p1y = p2y;
      }

      if (!inside) {
        return false;
      }
    }

    return true;
  }

  _calculatePolygonArea(polygon) {
    if (!polygon || polygon.length < 3) {
      return 0;
    }

    let areaTwice = 0;
    for (let i = 0; i < polygon.length; i += 1) {
      const [x1, y1] = polygon[i];
      const [x2, y2] = polygon[(i + 1) % polygon.length];
      areaTwice += x1 * y2 - x2 * y1;
    }
    return Math.abs(areaTwice);
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

  _computeTerritory(player) {
    const friendlyPoints = dedupePoints([
      ...this._getPlayerNodes(player),
      ...this._getPlayerLines(player),
    ]);
    const enemyPoints = dedupePoints(
      this._getOpponents(player).flatMap((opponent) => [
        ...this._getPlayerNodes(opponent),
        ...this._getPlayerLines(opponent),
      ]),
    );

    if (friendlyPoints.length < 3) {
      return { polygon: null, area: 0 };
    }

    const hullVertices = buildConvexHull(friendlyPoints);
    if (hullVertices.length < 3) {
      return { polygon: null, area: 0 };
    }

    const segmentPaths = [];
    for (let i = 0; i < hullVertices.length; i += 1) {
      const start = hullVertices[i];
      const end = hullVertices[(i + 1) % hullVertices.length];
      const paths = this.getAllShortestGridPaths(start, end, enemyPoints);
      if (paths.length === 0) {
        return { polygon: null, area: 0 };
      }
      segmentPaths.push(paths);
    }

    let bestPolygon = null;
    let minArea = Number.POSITIVE_INFINITY;
    const combinations = cartesianProduct(segmentPaths);

    for (const combination of combinations) {
      const polygon = [];
      for (const path of combination) {
        polygon.push(...path.slice(0, -1));
      }
      if (!this._polygonContainsAll(polygon, friendlyPoints)) {
        continue;
      }

      const area = this._calculatePolygonArea(polygon);
      if (area < minArea) {
        minArea = area;
        bestPolygon = polygon.map(clonePoint);
      }
    }

    if (!bestPolygon) {
      return { polygon: null, area: 0 };
    }

    return {
      polygon: bestPolygon,
      area: minArea,
    };
  }

  _updateTerritories() {
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
      if (this.consecutiveSkips >= 3) {
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
    const success = this._addNode(normalizedPoint);
    if (!success) {
      return {
        success: false,
        reason: "INVALID_MOVE",
        snapshot: this.getSnapshot(),
      };
    }

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
    if (this.consecutiveSkips >= 3) {
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
