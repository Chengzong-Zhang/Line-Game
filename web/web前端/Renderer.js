import { Player, PointState, PLAYER_ORDER, getBoardVertices, getBoardPositions, isBoardPoint } from "./GameEngine.js?v=20261025-defense15";

import { PLAYER_PALETTE } from "./PlayerPalette.js?v=20261025-defense15";

const SQRT3_OVER_2 = Math.sqrt(3) / 2;

// Renderer 鍙礋璐ｆ妸蹇収缁樺埗鍒?Canvas锛屼笉鍋氳鍒欏垽鏂€?// 杩欐牱鏃犺鏄湰鍦版ā寮忚繕鏄仈鏈哄洖鏀撅紝閮借兘鍏变韩瀹屽叏涓€鑷寸殑娓叉煋閫昏緫銆?
const DEFAULT_THEME = Object.freeze({
  background: "#f6f1e8",
  boardFill: "#fffaf0",
  boardStroke: "#d7c7ad",
  guideLine: "rgba(120, 101, 78, 0.18)",
  guidePoint: "#ccbda8",
  outline: "#3a3125",
  blueNode: "#2b6fff",
  blueLine: "#1f4fba",
  redNode: "#e44b4b",
  redLine: "#a83434",
  purpleNode: "#8b5cf6",
  purpleLine: "#6d28d9",
  greenNode: "#22965a",
  greenLine: "#166b3d",
  orangeNode: "#e79824",
  orangeLine: "#a8620d",
  cyanNode: "#16a6b6",
  cyanLine: "#087785",
  blueTerritoryFill: "rgba(43, 111, 255, 0.18)",
  blueTerritoryStroke: "rgba(31, 79, 186, 0.75)",
  redTerritoryFill: "rgba(228, 75, 75, 0.18)",
  redTerritoryStroke: "rgba(168, 52, 52, 0.75)",
  purpleTerritoryFill: "rgba(139, 92, 246, 0.18)",
  purpleTerritoryStroke: "rgba(109, 40, 217, 0.75)",
  greenTerritoryFill: "rgba(34, 150, 90, 0.18)",
  greenTerritoryStroke: "rgba(22, 107, 61, 0.75)",
  orangeTerritoryFill: "rgba(231, 152, 36, 0.18)",
  orangeTerritoryStroke: "rgba(168, 98, 13, 0.75)",
  cyanTerritoryFill: "rgba(22, 166, 182, 0.18)",
  cyanTerritoryStroke: "rgba(8, 119, 133, 0.75)",
  ...Object.fromEntries(PLAYER_ORDER.slice(6).flatMap(player => {
    const { accent, color } = PLAYER_PALETTE[player];
    return [[`${accent}Node`, color], [`${accent}Line`, color], [`${accent}TerritoryFill`, `${color}2e`], [`${accent}TerritoryStroke`, `${color}bf`]];
  })),
  legalMoveFill: "#2fba63",
  legalMoveStroke: "rgba(17, 84, 40, 0.35)",
});

const PLAYER_THEME_KEYS = Object.freeze({
  BLACK: "blue", WHITE: "red", PURPLE: "purple",
  ...Object.fromEntries(PLAYER_ORDER.map(player => [player, PLAYER_PALETTE[player].accent])),
});

const NODE_PLAYERS = new Map(PLAYER_ORDER.map((player) => [PointState[`${player}_NODE`], player]));

function keyToPoint(key) {
  const [x, y] = String(key).split(",").map(Number);
  return [x, y];
}

function pointEquals(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function subtractPoints(a, b) {
  return [a[0] - b[0], a[1] - b[1]];
}

function normalizeVector(vector) {
  const length = Math.hypot(vector[0], vector[1]) || 1;
  return [vector[0] / length, vector[1] / length];
}

function lineIntersection(lineA, lineB) {
  const determinant = lineA.direction[0] * lineB.direction[1] - lineA.direction[1] * lineB.direction[0];
  if (Math.abs(determinant) < 1e-6) {
    return null;
  }

  const delta = subtractPoints(lineB.point, lineA.point);
  const t = (delta[0] * lineB.direction[1] - delta[1] * lineB.direction[0]) / determinant;
  return [
    lineA.point[0] + lineA.direction[0] * t,
    lineA.point[1] + lineA.direction[1] * t,
  ];
}

export class Renderer {
  constructor(canvas, options = {}) {
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("Renderer expects a valid <canvas> element.");
    }

    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    if (!this.ctx) {
      throw new Error("2D canvas context is not available.");
    }

    this.theme = { ...DEFAULT_THEME, ...(options.theme ?? {}) };
    this.minCssWidth = options.minCssWidth ?? 220;
    this.minCssHeight = options.minCssHeight ?? 180;
    this.defaultCssWidth = options.defaultCssWidth ?? 960;
    this.defaultCssHeight = options.defaultCssHeight ?? 720;
    this.paddingRatio = options.paddingRatio ?? 0.025;
    this.topInset = options.topInset ?? 0;
    this.lastSnapshot = null;
    this.layout = null;
    this._resizeFrame = null;
    this._lastMeasuredWidth = 0;
    this._lastMeasuredHeight = 0;
    this._lastMeasuredDpr = 0;
    this._staticLayerKey = "";
    this._staticDomCanvas = null;
    this._staticCtx = null;
    this._hintDomCanvas = null;
    this._hintCtx = null;
    this._pendingRafHandle = null;
    this._pendingOptions = {};
    this._lastRenderFingerprint = "";
    this.cacheTerritoryPaths = options.cacheTerritoryPaths !== false;
    this._territoryPaths = new Map();
    // One entry per geometry/data kind, never per turn or snapshot. Compare
    // actual inputs: imported/replayed snapshots may share a revision number.
    this._renderCaches = new Map();
    this.cacheBoardPaths = options.cacheBoardPaths !== false;
    this._boardPaths = new Map();
    this.hintPoint = null;
    this._hintPulsePhase = 0;
    this._lastHintTimestamp = 0;
    this._animationFrameId = null;

    this.canvas.style.position = "absolute";
    this.canvas.style.top = "0";
    this.canvas.style.left = "0";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.background = "transparent";
    this.canvas.style.touchAction = "manipulation";

    // 闈欐€佸眰锛堝簳灞傦級锛氱粯鍒惰儗鏅拰妫嬬洏楠ㄦ灦锛屼笉鍙備笌浜嬩欢
    const staticDomCanvas = document.createElement("canvas");
    staticDomCanvas.style.position = "absolute";
    staticDomCanvas.style.top = "0";
    staticDomCanvas.style.left = "0";
    staticDomCanvas.style.width = "100%";
    staticDomCanvas.style.height = "100%";
    staticDomCanvas.style.pointerEvents = "none";
    this._staticDomCanvas = staticDomCanvas;
    this._staticCtx = staticDomCanvas.getContext("2d");
    const parent = this.canvas.parentElement;
    if (parent) {
      parent.insertBefore(staticDomCanvas, this.canvas);

      // Hint pulses live on their own transparent layer. Animating a hint no
      // longer redraws every node, edge, territory and legal-move marker.
      const hintDomCanvas = document.createElement("canvas");
      hintDomCanvas.style.position = "absolute";
      hintDomCanvas.style.top = "0";
      hintDomCanvas.style.left = "0";
      hintDomCanvas.style.width = "100%";
      hintDomCanvas.style.height = "100%";
      hintDomCanvas.style.pointerEvents = "none";
      hintDomCanvas.setAttribute("aria-hidden", "true");
      parent.insertBefore(hintDomCanvas, this.canvas.nextSibling);
      this._hintDomCanvas = hintDomCanvas;
      this._hintCtx = hintDomCanvas.getContext("2d");
    }

    this._resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          this._scheduleResize();
        })
      : null;

    if (this._resizeObserver) {
      this._resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
    }

    this.resize();
  }

  destroy() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
    }
    if (this._resizeFrame !== null) {
      globalThis.cancelAnimationFrame(this._resizeFrame);
      this._resizeFrame = null;
    }
    if (this._pendingRafHandle !== null) {
      globalThis.cancelAnimationFrame(this._pendingRafHandle);
      this._pendingRafHandle = null;
    }
    if (this._animationFrameId !== null) {
      globalThis.cancelAnimationFrame(this._animationFrameId);
      this._animationFrameId = null;
    }
    if (this._staticDomCanvas) {
      this._staticDomCanvas.remove();
      this._staticDomCanvas = null;
      this._staticCtx = null;
    }
    if (this._hintDomCanvas) {
      this._hintDomCanvas.remove();
      this._hintDomCanvas = null;
      this._hintCtx = null;
    }
    this._staticLayerKey = "";
    this._renderCaches?.clear();
    this._territoryPaths?.clear();
    this._boardPaths?.clear();
  }

  invalidate() {
    this._lastRenderFingerprint = "";
    this._staticLayerKey = "";
    this._territoryPaths?.clear();
    this._renderCaches?.clear();
    this._boardPaths?.clear();
  }

  _scheduleResize() {
    if (this._resizeFrame !== null) {
      return;
    }

    this._resizeFrame = globalThis.requestAnimationFrame(() => {
      this._resizeFrame = null;
      const resized = this.resize();
      if (resized && this.lastSnapshot) {
        this.render(this.lastSnapshot, { skipResize: true, _immediate: true });
      }
    });
  }

  resize() {
    const { cssWidth, cssHeight, dpr } = this._measureCanvas();
    const widthChanged = Math.abs(cssWidth - this._lastMeasuredWidth) >= 2;
    const heightChanged = Math.abs(cssHeight - this._lastMeasuredHeight) >= 2;
    const dprChanged = Math.abs(dpr - this._lastMeasuredDpr) >= 0.1;

    if (!widthChanged && !heightChanged && !dprChanged) {
      return false;
    }

    this._lastMeasuredWidth = cssWidth;
    this._lastMeasuredHeight = cssHeight;
    this._lastMeasuredDpr = dpr;
    this._staticLayerKey = "";

    const physW = Math.round(cssWidth * dpr);
    const physH = Math.round(cssHeight * dpr);

    if (this.canvas.width !== physW || this.canvas.height !== physH) {
      this.canvas.width = physW;
      this.canvas.height = physH;
    }
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;

    if (this._staticDomCanvas) {
      if (this._staticDomCanvas.width !== physW || this._staticDomCanvas.height !== physH) {
        this._staticDomCanvas.width = physW;
        this._staticDomCanvas.height = physH;
      }
      this._staticDomCanvas.style.width = `${cssWidth}px`;
      this._staticDomCanvas.style.height = `${cssHeight}px`;
      if (this._staticCtx) {
        this._staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._staticCtx.imageSmoothingEnabled = true;
      }
    }

    if (this._hintDomCanvas) {
      if (this._hintDomCanvas.width !== physW || this._hintDomCanvas.height !== physH) {
        this._hintDomCanvas.width = physW;
        this._hintDomCanvas.height = physH;
      }
      this._hintDomCanvas.style.width = `${cssWidth}px`;
      this._hintDomCanvas.style.height = `${cssHeight}px`;
      this._hintCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (this._hintCtx) this._hintCtx.imageSmoothingEnabled = true;
    }
    return true;
  }

  _measureCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    // The canvas has an inline pixel size after rendering. Measure its frame
    // so a narrower viewport does not keep using the previous canvas size.
    const frame = this.canvas.parentElement;
    const cssWidth = Math.max(
      frame?.clientWidth ? 1 : this.minCssWidth,
      Math.round(frame?.clientWidth || rect.width || this.canvas.clientWidth || this.canvas.width || this.defaultCssWidth),
    );
    const cssHeight = Math.max(
      frame?.clientHeight ? 1 : this.minCssHeight,
      Math.round(frame?.clientHeight || rect.height || this.canvas.clientHeight || this.canvas.height || this.defaultCssHeight),
    );
    const prefersLowerDpr = globalThis.matchMedia?.("(pointer: coarse)")?.matches || window.innerWidth <= 768;
    const dpr = clamp(window.devicePixelRatio || 1, 1, prefersLowerDpr ? 2 : 3);

    return { cssWidth, cssHeight, dpr };
  }

  _getValidPoints(gridSize, playerCount = 2, boardShape = null) {
    const key = JSON.stringify([gridSize, playerCount, boardShape]);
    this._renderCaches ??= new Map();
    const cached = this._renderCaches.get("points");
    if (cached?.key === key) return cached.value;
    const value = getBoardPositions(gridSize, playerCount, boardShape);
    this._renderCaches.set("points", { key, value });
    return value;
  }

  _computeLayout(snapshot) {
    // 浼樺厛澶嶇敤 resize() 宸叉祴閲忓苟缂撳瓨鐨勫€硷紝閬垮厤閲嶅瑙﹀彂 getBoundingClientRect layout reflow
    const cssWidth = this._lastMeasuredWidth > 0 ? this._lastMeasuredWidth : this._measureCanvas().cssWidth;
    const cssHeight = this._lastMeasuredHeight > 0 ? this._lastMeasuredHeight : this._measureCanvas().cssHeight;
    const topInset = clamp(this.topInset ?? 0, 0, Math.max(0, cssHeight - 1));
    const boardHeight = Math.max(1, cssHeight - topInset);
    const gridSize = snapshot?.gridSize ?? 9;
    const playerCount = snapshot?.playerCount ?? 2;
    const boardShape = snapshot?.boardShape;
    const layoutKey = JSON.stringify([cssWidth, cssHeight, topInset, gridSize, playerCount, boardShape, this.paddingRatio]);
    this._renderCaches ??= new Map();
    const cachedLayout = this._renderCaches.get("layout");
    if (cachedLayout?.key === layoutKey) return cachedLayout.value;
    const validPoints = this._getValidPoints(gridSize, playerCount, boardShape);
    const normalizedPoints = validPoints.map(([gx, gy]) => [gx + gy * 0.5, gy * SQRT3_OVER_2]);

    let minNX = Number.POSITIVE_INFINITY;
    let maxNX = Number.NEGATIVE_INFINITY;
    let minNY = Number.POSITIVE_INFINITY;
    let maxNY = Number.NEGATIVE_INFINITY;

    for (const [nx, ny] of normalizedPoints) {
      minNX = Math.min(minNX, nx);
      maxNX = Math.max(maxNX, nx);
      minNY = Math.min(minNY, ny);
      maxNY = Math.max(maxNY, ny);
    }

    const outerPadding = Math.max(12, Math.min(cssWidth, boardHeight) * this.paddingRatio);
    const usableWidth = Math.max(1, cssWidth - outerPadding * 2);
    const usableHeight = Math.max(1, boardHeight - outerPadding * 2);
    const logicalWidth = Math.max(1, maxNX - minNX);
    const logicalHeight = Math.max(1, maxNY - minNY);
    // Reserve room for the expanded triangular border and corner stones,
    // including small grids whose stones grow with the spacing.
    const scale = Math.min(usableWidth / (logicalWidth + 0.9), usableHeight / (logicalHeight + 0.9));
    const padding = outerPadding + scale * 0.45;
    const offsetX = (cssWidth - logicalWidth * scale) * 0.5 - minNX * scale;
    const offsetY = topInset + (boardHeight - logicalHeight * scale) * 0.5 - minNY * scale;

    const layout = {
      cssWidth,
      cssHeight,
      topInset,
      gridSize,
      playerCount,
      boardShape,
      scale,
      offsetX,
      offsetY,
      padding,
      pointRadius: Math.max(5, scale * 0.13),
      guidePointRadius: Math.max(2, scale * 0.04),
      lineWidth: Math.max(3, scale * 0.08),
      guideLineWidth: Math.max(1, scale * 0.028),
      territoryLineWidth: Math.max(2, scale * 0.05),
      legalMoveRadius: Math.max(4, scale * 0.08),
      normalizedBounds: { minNX, maxNX, minNY, maxNY },
    };
    this._renderCaches.set("layout", { key: layoutKey, value: layout });
    return layout;
  }

  _gridToPixel(gx, gy, layout = this.layout) {
    if (!layout) {
      throw new Error("Layout is not available. Call render(snapshot) first.");
    }

    // Math.round 淇濊瘉鍧愭爣钀藉湪鏁存暟鍍忕礌锛屾秷闄や簹鍍忕礌鎶楅敮榻跨殑 fillRate 寮€閿€
    const x = Math.round(layout.offsetX + (gx + gy * 0.5) * layout.scale);
    const y = Math.round(layout.offsetY + gy * SQRT3_OVER_2 * layout.scale);
    return [x, y];
  }

  getPointPixelCoordinates(gx, gy) {
    const point = Array.isArray(gx) ? gx : [gx, gy];
    if (!this.layout) {
      const snapshot = this.lastSnapshot ?? { gridSize: 9 };
      this.layout = this._computeLayout(snapshot);
    }
    const [x, y] = this._gridToPixel(point[0], point[1], this.layout);
    return { x, y };
  }

  getHitRadius() {
    if (!this.layout) {
      const snapshot = this.lastSnapshot ?? { gridSize: 9 };
      this.layout = this._computeLayout(snapshot);
    }
    // Pick the nearest grid point within almost one triangular grid cell.
    // Input still checks that exact point's legality, never a nearby legal move.
    return Math.max(12, this.layout.scale * 0.58);
  }

  setHintPoint(point) {
    if (!point) {
      this.clearHintPoint();
      return;
    }

    this.hintPoint = [point[0], point[1]];
    this._hintPulsePhase = 0;
    this._lastHintTimestamp = 0;
    if (this._hintCtx) {
      if (!this.layout && this.lastSnapshot) this.layout = this._computeLayout(this.lastSnapshot);
      this._renderHintLayer();
    } else {
      this._lastRenderFingerprint = "";
    }

    if (!this._hintCtx && this.lastSnapshot) {
      this.render(this.lastSnapshot);
    }
    if (this._animationFrameId === null) {
      this._animationFrameId = globalThis.requestAnimationFrame((timestamp) => {
        this._renderHintAnimation(timestamp);
      });
    }
  }

  clearHintPoint() {
    const hadHint = this.hintPoint !== null;
    this.hintPoint = null;
    this._hintPulsePhase = 0;
    this._lastHintTimestamp = 0;
    if (this._animationFrameId !== null) {
      globalThis.cancelAnimationFrame(this._animationFrameId);
      this._animationFrameId = null;
    }

    if (this._hintCtx) {
      this._clearHintLayer();
    } else if (hadHint && this.lastSnapshot) {
      this._lastRenderFingerprint = "";
      this.render(this.lastSnapshot);
    }
  }

  _renderHintAnimation(timestamp) {
    this._animationFrameId = null;
    if (!this.hintPoint || !this.lastSnapshot) {
      return;
    }

    if (this._lastHintTimestamp === 0) {
      this._lastHintTimestamp = timestamp;
    }
    this._hintPulsePhase = ((timestamp - this._lastHintTimestamp) % 1200) / 1200;
    if (this._hintCtx) {
      this._renderHintLayer();
    } else {
      this._doRender(this.lastSnapshot, { skipResize: true, force: true });
    }
    this._animationFrameId = globalThis.requestAnimationFrame((nextTimestamp) => {
      this._renderHintAnimation(nextTimestamp);
    });
  }

  _isValidGridPoint(point, gridSize, playerCount = 2, boardShape = null) {
    return isBoardPoint(point, gridSize, playerCount, boardShape);
  }

  _canConnect(a, b) {
    return a[0] === b[0] || a[1] === b[1] || a[0] + a[1] === b[0] + b[1];
  }

  _getLinePoints(start, end, gridSize, playerCount = 2, boardShape = null) {
    if (!this._canConnect(start, end)) {
      return [];
    }

    const [x1, y1] = start;
    const [x2, y2] = end;
    const points = [];

    if (x1 === x2) {
      for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y += 1) {
        const point = [x1, y];
        if (this._isValidGridPoint(point, gridSize, playerCount, boardShape)) {
          points.push(point);
        }
      }
      return points;
    }

    if (y1 === y2) {
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x += 1) {
        const point = [x, y1];
        if (this._isValidGridPoint(point, gridSize, playerCount, boardShape)) {
          points.push(point);
        }
      }
      return points;
    }

    const left = x1 < x2 ? [x1, y1] : [x2, y2];
    const right = x1 < x2 ? [x2, y2] : [x1, y1];
    for (let i = 0; i <= right[0] - left[0]; i += 1) {
      const point = [left[0] + i, left[1] - i];
      if (this._isValidGridPoint(point, gridSize, playerCount, boardShape)) {
        points.push(point);
      }
    }
    return points;
  }

  _getOwnedStates(player) {
    return [this._getNodeState(player), this._getLineState(player)];
  }

  _getNodeState(player) {
    return PointState[`${player}_NODE`];
  }

  _getLineState(player) {
    return PointState[`${player}_LINE`];
  }

  _getPlayerStyle(player, part) {
    return this.theme[`${PLAYER_THEME_KEYS[player]}${part}`] ?? this.theme.outline;
  }

  _collectBoardData(snapshot) {
    const gridSize = snapshot.gridSize;
    const playerCount = snapshot.playerCount ?? 2;
    const board = snapshot.boardMatrix;
    const boardShape = snapshot?.boardShape;
    const key = JSON.stringify([gridSize, playerCount, boardShape, board]);
    this._renderCaches ??= new Map();
    const cached = this._renderCaches.get("board");
    if (cached?.key === key) {
      // Snapshot producers may clone matrices or mutate an older snapshot.
      // Keep the current matrix, while reusing only the derived node lists.
      cached.value.board = board;
      return cached.value;
    }
    const validPoints = this._getValidPoints(gridSize, playerCount, boardShape);
    const nodes = Object.fromEntries(PLAYER_ORDER.map((player) => [player, []]));

    for (const point of validPoints) {
      const [x, y] = point;
      const state = board[y][x];
      const player = NODE_PLAYERS.get(state);
      if (player) nodes[player].push(point);
    }

    const value = {
      gridSize,
      playerCount,
      boardShape,
      validPoints,
      board,
      nodes,
    };
    this._renderCaches.set("board", { key, value });
    return value;
  }

  _collectRenderableSegments(player, boardData) {
    const nodeState = this._getNodeState(player);
    const ownedStates = new Set(this._getOwnedStates(player));
    const playerNodes = boardData.nodes[player];
    const board = boardData.board;
    const segments = [];

    for (let i = 0; i < playerNodes.length; i += 1) {
      for (let j = i + 1; j < playerNodes.length; j += 1) {
        const start = playerNodes[i];
        const end = playerNodes[j];
        if (!this._canConnect(start, end)) {
          continue;
        }

        const linePoints = this._getLinePoints(start, end, boardData.gridSize, boardData.playerCount, boardData.boardShape);
        // O(1) 浜岀淮鏁扮粍绱㈠紩锛屾棤瀛楃涓叉嫾鎺?Map 鏌ユ壘
        const fullyOwned = linePoints.every((point) => ownedStates.has(board[point[1]][point[0]]));
        if (!fullyOwned) {
          continue;
        }

        const hasIntermediateNode = linePoints.some((point) => {
          if (pointEquals(point, start) || pointEquals(point, end)) {
            return false;
          }
          return board[point[1]][point[0]] === nodeState;
        });
        if (hasIntermediateNode) {
          continue;
        }

        segments.push([start, end]);
      }
    }

    return segments;
  }

  _getSnapshotSegments(snapshot, player) {
    const edgeKeys = Array.isArray(snapshot?.edges?.[player]) ? snapshot.edges[player] : null;
    if (!edgeKeys) {
      return null;
    }

    const key = JSON.stringify(edgeKeys);
    const cacheName = `segments:${player}`;
    this._renderCaches ??= new Map();
    const cached = this._renderCaches.get(cacheName);
    if (cached?.key === key) return cached.value;
    const value = edgeKeys.map((edgeKey) => {
      const [startKey, endKey] = String(edgeKey).split("|");
      return [keyToPoint(startKey), keyToPoint(endKey)];
    });
    this._renderCaches.set(cacheName, { key, value });
    return value;
  }

  _getStaticLayerKey(snapshot, layout) {
    return [
      snapshot?.gridSize ?? 9,
      snapshot?.playerCount ?? 2,
      snapshot?.boardShape ?? "legacy",
      layout.cssWidth,
      layout.cssHeight,
      Math.round(layout.scale * 1000),
      layout.offsetX,
      layout.offsetY,
      Math.round((this._lastMeasuredDpr || 1) * 10),
      JSON.stringify(this.theme),
    ].join(":");
  }

  _ensureStaticLayer(snapshot, boardData, layout) {
    const nextKey = this._getStaticLayerKey(snapshot, layout);
    if (this._staticLayerKey === nextKey) {
      return;
    }

    if (!this._staticCtx) {
      this._staticLayerKey = "";
      return;
    }

    // 鐩存帴缁樺埗鍒板簳灞?DOM canvas锛屾棤闇€绂诲睆 blit
    const previousCtx = this.ctx;
    this.ctx = this._staticCtx;
    this._drawBackground(layout);
    this._drawGridSkeleton(boardData, layout);
    this.ctx = previousCtx;

    this._staticLayerKey = nextKey;
  }

  _drawBackground(layout) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, layout.cssWidth, layout.cssHeight);

    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, 0, layout.cssWidth, layout.cssHeight);

    const corners = getBoardVertices(layout.gridSize, layout.playerCount, layout.boardShape)
      .map(([x, y]) => this._gridToPixel(x, y, layout));
    const centerX = corners.reduce((sum, [x]) => sum + x, 0) / corners.length;
    const centerY = corners.reduce((sum, [, y]) => sum + y, 0) / corners.length;
    const borderInset = layout.pointRadius * 1.6;
    const offsetLines = corners.map((point, index) => {
      const nextPoint = corners[(index + 1) % corners.length];
      const edge = subtractPoints(nextPoint, point);
      const unitDirection = normalizeVector(edge);
      let normal = normalizeVector([unitDirection[1], -unitDirection[0]]);
      const midpoint = [(point[0] + nextPoint[0]) * 0.5, (point[1] + nextPoint[1]) * 0.5];
      const toCenter = [centerX - midpoint[0], centerY - midpoint[1]];
      if (normal[0] * toCenter[0] + normal[1] * toCenter[1] > 0) {
        normal = [-normal[0], -normal[1]];
      }
      return {
        point: [
          point[0] + normal[0] * borderInset,
          point[1] + normal[1] * borderInset,
        ],
        direction: unitDirection,
      };
    });
    const expandedCorners = offsetLines.map((line, index) => {
      const previousLine = offsetLines[(index + offsetLines.length - 1) % offsetLines.length];
      return lineIntersection(previousLine, line) ?? corners[index];
    });

    ctx.beginPath();
    ctx.moveTo(expandedCorners[0][0], expandedCorners[0][1]);
    for (const [x, y] of expandedCorners.slice(1)) ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fillStyle = this.theme.boardFill;
    ctx.strokeStyle = this.theme.boardStroke;
    ctx.lineWidth = Math.max(2, layout.guideLineWidth * 2);
    ctx.fill();
    ctx.stroke();
  }

  _drawGridSkeleton(boardData, layout) {
    const ctx = this.ctx;

    ctx.strokeStyle = this.theme.guideLine;
    ctx.lineWidth = layout.guideLineWidth;
    ctx.beginPath();
    for (const point of boardData.validPoints) {
      for (const neighbor of [[point[0] + 1, point[1]], [point[0], point[1] + 1], [point[0] + 1, point[1] - 1]]) {
        if (!this._isValidGridPoint(neighbor, boardData.gridSize, boardData.playerCount, boardData.boardShape)) {
          continue;
        }
        const [x1, y1] = this._gridToPixel(point[0], point[1], layout);
        const [x2, y2] = this._gridToPixel(neighbor[0], neighbor[1], layout);
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
    }
    ctx.stroke();

    // 灏嗘墍鏈夊寮曠偣鍚堝苟涓哄崟娆?fill()锛岄伩鍏?N 娆″崟鐙?beginPath/fill 璋冪敤
    ctx.fillStyle = this.theme.guidePoint;
    ctx.beginPath();
    for (const point of boardData.validPoints) {
      const [x, y] = this._gridToPixel(point[0], point[1], layout);
      ctx.moveTo(x + layout.guidePointRadius, y);
      ctx.arc(x, y, layout.guidePointRadius, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  _getBoardPath(name, content, layout, trace) {
    this._boardPaths ??= new Map();
    const key = JSON.stringify([layout.scale, layout.offsetX, layout.offsetY,
      layout.pointRadius, layout.legalMoveRadius, content]);
    const previous = this._boardPaths.get(name);
    if (previous?.key === key) return previous.path;
    const path = new Path2D();
    trace(path);
    // Each entry replaces its predecessor: six edge groups, at most six
    // node groups and one legal-move group, independent of game length.
    this._boardPaths.set(name, { key, path });
    return path;
  }

  _drawSegments(snapshot, boardData, layout, cachePaths = false) {
    const ctx = this.ctx;
    for (const player of PLAYER_ORDER.slice(0, boardData.playerCount)) {
      const segments = this._getSnapshotSegments(snapshot, player)
        ?? this._collectRenderableSegments(player, boardData);
      if (!segments.length) {
        continue;
      }

      ctx.strokeStyle = this._getPlayerStyle(player, "Line");
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = layout.lineWidth;
      ctx.beginPath();

      const trace = target => {
        for (const [start, end] of segments) {
          const [x1, y1] = this._gridToPixel(start[0], start[1], layout);
          const [x2, y2] = this._gridToPixel(end[0], end[1], layout);
          target.moveTo(x1, y1);
          target.lineTo(x2, y2);
        }
      };
      if (cachePaths) ctx.stroke(this._getBoardPath(`edges:${player}`, segments, layout, trace));
      else { trace(ctx); ctx.stroke(); }
    }
  }

  _drawTerritories(snapshot, layout) {
    // During calculation, only independently completed CURRENT-position
    // polygons are visible. Never substitute the previous board's score cache.
    const visible = snapshot.territoryPending ? snapshot.renderTerritories : snapshot.territories;
    if (!visible) return;
    const ctx = this.ctx;
    const territories = PLAYER_ORDER.map((player) => ({
      player,
      data: visible?.[player],
      fill: this._getPlayerStyle(player, "TerritoryFill"),
      stroke: this._getPlayerStyle(player, "TerritoryStroke"),
    }));

    for (const territory of territories) {
      const polygon = territory.data?.polygon;
      if (!polygon || polygon.length < 3) {
        continue;
      }

      ctx.save();
      this._territoryPaths ??= new Map();
      let path = null;
      if (this.cacheTerritoryPaths !== false && typeof Path2D === "function") {
        const cached = this._territoryPaths.get(territory.player);
        const unchanged = cached?.scale === layout.scale && cached?.offsetX === layout.offsetX
          && cached?.offsetY === layout.offsetY && cached.points.length === polygon.length
          && polygon.every((point, index) => point[0] === cached.points[index][0] && point[1] === cached.points[index][1]);
        if (unchanged) path = cached.path;
        else {
          path = new Path2D();
          this._traceTerritory(path, polygon, layout);
          this._territoryPaths.set(territory.player, { path, scale: layout.scale,
            offsetX: layout.offsetX, offsetY: layout.offsetY, points: polygon.map(point => [...point]) });
        }
      } else {
        ctx.beginPath();
        this._traceTerritory(ctx, polygon, layout);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = territory.fill;
      if (path) ctx.fill(path); else ctx.fill();
      ctx.strokeStyle = territory.stroke;
      ctx.lineWidth = layout.territoryLineWidth;
      if (path) ctx.stroke(path); else ctx.stroke();
      ctx.restore();
    }
  }

  _traceTerritory(target, polygon, layout) {
    polygon.forEach(([gx, gy], index) => {
      const [x, y] = this._gridToPixel(gx, gy, layout);
      if (index === 0) target.moveTo(x, y); else target.lineTo(x, y);
    });
    target.closePath();
  }

  _drawStartingPoints(snapshot, layout) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = Math.max(1.5, layout.lineWidth * 0.35);
    for (const [player, point] of Object.entries(snapshot.initialPositions ?? {})) {
      const [x, y] = this._gridToPixel(point[0], point[1], layout);
      ctx.strokeStyle = this._getPlayerStyle(player, "Node");
      ctx.beginPath();
      ctx.arc(x, y, layout.pointRadius + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawNodes(boardData, layout, cachePaths = false) {
    const ctx = this.ctx;
    const groups = PLAYER_ORDER.map((player) => ({
      player, points: boardData.nodes[player], fill: this._getPlayerStyle(player, "Node"),
    })).filter(group => group.points?.length);

    ctx.lineWidth = Math.max(1.5, layout.lineWidth * 0.25);
    ctx.strokeStyle = this.theme.outline;
    for (const group of groups) {
      if (!group.points?.length) {
        continue;
      }

      ctx.beginPath();
      const trace = target => {
        for (const point of group.points) {
          const [x, y] = this._gridToPixel(point[0], point[1], layout);
          target.moveTo(x + layout.pointRadius, y);
          target.arc(x, y, layout.pointRadius, 0, Math.PI * 2);
        }
      };
      // Canvas save/restore does not save currentPath. The legacy last-action
      // drawing may inherit it, so the final nonempty group always traces the
      // original context path. Earlier groups can use equivalent cached paths.
      if (cachePaths && group !== groups[groups.length - 1]) {
        const path = this._getBoardPath(`nodes:${group.player}`, group.points, layout, trace);
        ctx.fillStyle = group.fill;
        ctx.fill(path); ctx.stroke(path);
      } else { trace(ctx); ctx.fillStyle = group.fill; ctx.fill(); ctx.stroke(); }
    }
  }

  _drawLegalMoves(snapshot, layout, cachePaths = false) {
    const ctx = this.ctx;
    const legalMoves = Array.isArray(snapshot.legalMoves) ? snapshot.legalMoves : [];
    if (!legalMoves.length) {
      return;
    }

    const r = layout.legalMoveRadius;
    ctx.beginPath();
    const trace = target => {
      for (const candidate of legalMoves) {
        const point = Array.isArray(candidate) ? candidate : candidate?.point;
        if (!Array.isArray(point) || point.length !== 2) continue;
        const [x, y] = this._gridToPixel(point[0], point[1], layout);
        target.moveTo(x, y - r);
        target.lineTo(x + r, y);
        target.lineTo(x, y + r);
        target.lineTo(x - r, y);
        target.closePath();
      }
    };
    const path = cachePaths ? this._getBoardPath("legal", legalMoves, layout, trace) : null;
    if (!path) trace(ctx);
    ctx.fillStyle = this.theme.legalMoveFill;
    if (path) ctx.fill(path); else ctx.fill();
    ctx.lineWidth = Math.max(1.25, layout.guideLineWidth * 1.8);
    ctx.strokeStyle = this.theme.legalMoveStroke;
    if (path) ctx.stroke(path); else ctx.stroke();
  }

  _drawLastAction(snapshot, layout) {
    const action = snapshot?.lastAction;
    if (!action || action.type !== "move" || !Array.isArray(action.point) || action.point.length !== 2) {
      return;
    }

    const ctx = this.ctx;
    const playerColors = Object.fromEntries(PLAYER_ORDER.map((player) => [player, this._getPlayerStyle(player, "Line")]));
    const [x, y] = this._gridToPixel(action.point[0], action.point[1], layout);
    const stroke = playerColors[action.player] ?? this.theme.outline;

    const ringRadius = layout.pointRadius + Math.max(6, layout.pointRadius * 0.55);
    const glowRadius = ringRadius + Math.max(5, layout.pointRadius * 0.7);

    ctx.save();
    // 澶栧眰鍗婇€忔槑瀹炲績鍦嗘ā鎷熷厜鏅曪紙鏇夸唬 shadowBlur锛岀Щ鍔ㄧ鎬ц兘鏇村ソ锛?    ctx.beginPath();
    ctx.arc(x, y, glowRadius, 0, Math.PI * 2);
    ctx.fillStyle = stroke;
    ctx.globalAlpha = 0.22;
    ctx.fill();
    ctx.globalAlpha = 1;

    // 鎻忚竟鍏夊湀
    ctx.beginPath();
    ctx.arc(x, y, ringRadius, 0, Math.PI * 2);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(2.5, layout.lineWidth * 0.3);
    ctx.stroke();

    // 涓績灏忕櫧鐐?    ctx.beginPath();
    ctx.arc(x, y, Math.max(2.5, layout.pointRadius * 0.28), 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
    ctx.fill();
    ctx.restore();
  }

  _drawInspectionOverlay(snapshot, layout) {
    const overlay = snapshot?.inspectionOverlay;
    if (!overlay) {
      return;
    }

    const ctx = this.ctx;
    const playerColors = Object.fromEntries(PLAYER_ORDER.map((player) => [player, this._getPlayerStyle(player, "Line")]));

    // In a lesson, cleared lines must stay absent from the resulting board.
    // The crossed-out empty points show what disappeared without redrawing it.
    const highlightedEdges = overlay.tutorial
      ? (overlay.addedEdges ?? [])
      : [...(overlay.addedEdges ?? []), ...(overlay.removedEdges ?? []).map((edge) => ({ ...edge, removed: true }))];
    for (const item of highlightedEdges) {
      const [fromKey, toKey] = String(item.edge ?? "").split("|");
      if (!fromKey || !toKey) {
        continue;
      }
      const from = keyToPoint(fromKey);
      const to = keyToPoint(toKey);
      const [fromX, fromY] = this._gridToPixel(from[0], from[1], layout);
      const [toX, toY] = this._gridToPixel(to[0], to[1], layout);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(fromX, fromY);
      ctx.lineTo(toX, toY);
      if (overlay.tutorial) {
        ctx.strokeStyle = item.removed ? "rgba(228, 75, 75, 0.25)" : "rgba(255, 199, 53, 0.6)";
        ctx.lineWidth = Math.max(8, layout.lineWidth * 2);
        ctx.stroke();
      }
      ctx.strokeStyle = playerColors[item.player] ?? this.theme.outline;
      ctx.lineWidth = Math.max(3, layout.lineWidth * 0.85);
      ctx.globalAlpha = 0.82;
      ctx.setLineDash([Math.max(6, layout.scale * 0.12), Math.max(4, layout.scale * 0.08)]);
      ctx.stroke();
      ctx.restore();
    }

    for (const point of [...(overlay.capturedPoints ?? []), ...(overlay.blockedPoint ? [overlay.blockedPoint] : [])]) {
      if (!Array.isArray(point) || point.length !== 2) {
        continue;
      }
      const [x, y] = this._gridToPixel(point[0], point[1], layout);
      const radius = layout.pointRadius + Math.max(5, layout.scale * 0.12);
      ctx.save();
      ctx.strokeStyle = "rgba(210, 73, 54, 0.95)";
      ctx.lineWidth = Math.max(2, layout.lineWidth * 0.5);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - radius * 0.58, y - radius * 0.58);
      ctx.lineTo(x + radius * 0.58, y + radius * 0.58);
      ctx.moveTo(x + radius * 0.58, y - radius * 0.58);
      ctx.lineTo(x - radius * 0.58, y + radius * 0.58);
      ctx.stroke();
      ctx.restore();
    }

    const selectedPoint = overlay.selectedPoint;
    if (Array.isArray(selectedPoint) && selectedPoint.length === 2) {
      const [x, y] = this._gridToPixel(selectedPoint[0], selectedPoint[1], layout);
      const radius = layout.pointRadius + Math.max(8, layout.scale * 0.18);
      ctx.save();
      ctx.strokeStyle = "rgba(218, 151, 36, 0.98)";
      ctx.fillStyle = "rgba(255, 226, 117, 0.2)";
      ctx.lineWidth = Math.max(2.5, layout.lineWidth * 0.65);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  _clearHintLayer() {
    if (!this._hintCtx || !this._hintDomCanvas) return;
    this._hintCtx.save();
    this._hintCtx.setTransform(1, 0, 0, 1, 0, 0);
    this._hintCtx.clearRect(0, 0, this._hintDomCanvas.width, this._hintDomCanvas.height);
    this._hintCtx.restore();
  }

  _renderHintLayer() {
    this._clearHintLayer();
    if (this.hintPoint && this.layout) this._drawHint(this.layout, this._hintCtx);
  }

  _drawHint(layout, targetCtx = this.ctx) {
    if (!this.hintPoint) {
      return;
    }

    const { x, y } = this.getPointPixelCoordinates(this.hintPoint);
    const pulse = (Math.sin(this._hintPulsePhase * Math.PI * 2) + 1) * 0.5;
    const radius = layout.scale * (0.25 + pulse * 0.15);
    const ctx = targetCtx;

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 215, 0, 0.7)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 165, 0, 0.9)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  _getBoardFingerprint(snapshot) {
    const lp = snapshot.lastAction?.point;
    return [
      snapshot.renderEpoch ?? 0,
      snapshot.positionRevision ?? snapshot.turnCount ?? 0,
      snapshot.playerCount ?? 2,
      snapshot.boardShape ?? "legacy",
      snapshot.rulesVersion ?? "territory-v1",
      snapshot.gameOver ? 1 : 0,
      snapshot.territoryPending ? 1 : 0,
      snapshot.currentPlayer,
      snapshot.lastAction?.type ?? "none",
      snapshot.lastAction?.player ?? "none",
      lp ? `${lp[0]},${lp[1]}` : "-",
      JSON.stringify(snapshot.inspectionOverlay ?? null),
      JSON.stringify(snapshot.initialPositions ?? null),
      // A same-revision snapshot can still carry a new preview, imported
      // board or legal-move list. These are display inputs, not rule state.
      JSON.stringify([snapshot.boardMatrix, snapshot.edges, snapshot.legalMoves,
        snapshot.territoryPending ? snapshot.renderTerritories : snapshot.territories]),
    ].join(":");
  }

  render(snapshot, options = {}) {
    if (!snapshot || !snapshot.boardMatrix) {
      throw new Error("Renderer.render(snapshot) requires a valid GameEngine snapshot.");
    }
    this.lastSnapshot = snapshot;

    // _immediate 鐢卞唴閮?resize 璺緞浣跨敤锛屾鏃跺凡鍦?rAF 鍐咃紝鐩存帴缁樺埗
    if (options._immediate) {
      this._doRender(snapshot, options);
      return;
    }

    this._pendingOptions = options;
    if (this._pendingRafHandle !== null) {
      return;
    }
    this._pendingRafHandle = globalThis.requestAnimationFrame(() => {
      this._pendingRafHandle = null;
      this._doRender(this.lastSnapshot, this._pendingOptions);
    });
  }

  _doRender(snapshot, options = {}) {
    if (!snapshot || !snapshot.boardMatrix) {
      return;
    }
    if (!options.skipResize) {
      this.resize();
    }
    this.layout = this._computeLayout(snapshot);

    // 鑴忔鏌ワ細闈欐€佸眰 key 鍙樺寲锛坮esize/gridSize 鏀瑰彉锛変篃闇€瑕侀噸缁樺姩鎬佸眰
    const fingerprint = `${this._getBoardFingerprint(snapshot)}:${this._getStaticLayerKey(snapshot, this.layout)}`;
    if (!options.force && fingerprint === this._lastRenderFingerprint) {
      return;
    }
    this._lastRenderFingerprint = fingerprint;

    const boardData = this._collectBoardData(snapshot);
    this._ensureStaticLayer(snapshot, boardData, this.layout);

    // 鍙竻闄ゅ姩鎬佸眰锛堥《灞傦級锛岄潤鎬佸眰锛堝簳灞?DOM canvas锛夋寔涔呬繚瀛橈紝鏃犻渶姣忓抚 blit
    if (this._staticCtx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    } else {
      // 鏃犻潤鎬佸眰鏃堕檷绾э細鍦ㄤ富 canvas 涓婄洿鎺ョ粯鍒惰儗鏅拰楠ㄦ灦
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this._drawBackground(this.layout);
      this._drawGridSkeleton(boardData, this.layout);
    }
    // All cached paths precede an original context-path node draw. This keeps
    // both drawing order and the final currentPath identical, including old
    // snapshots without starting-point rings. Minimal Path2D shims fall back.
    const cachePaths = this.cacheBoardPaths !== false && typeof Path2D === "function"
      && typeof Path2D.prototype.arc === "function"
      && PLAYER_ORDER.some(player => boardData.nodes[player]?.length);
    this._drawSegments(snapshot, boardData, this.layout, cachePaths);
    this._drawTerritories(snapshot, this.layout);
    this._drawLegalMoves(snapshot, this.layout, cachePaths);
    this._drawNodes(boardData, this.layout, cachePaths);
    this._drawStartingPoints(snapshot, this.layout);
    this._drawLastAction(snapshot, this.layout);
    this._drawInspectionOverlay(snapshot, this.layout);
    if (this._hintCtx) {
      this._renderHintLayer();
    } else {
      this._drawHint(this.layout);
    }
  }
}

export default Renderer;
