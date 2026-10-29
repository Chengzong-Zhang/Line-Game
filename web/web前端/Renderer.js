import {
  Player,
  PointState,
  PLAYER_ORDER,
  getBoardVertices,
  getBoardPositions,
  isBoardPoint,
} from "./GameEngine.js?v=20261029-unified-r1";

const SQRT3_OVER_2 = Math.sqrt(3) / 2;
const TOPOLOGY_BOARD_VIEW_RUNTIME = Symbol.for("lifeline.topology-board-view-runtime.v1");

function getTopologyBoardViewRuntime() {
  const runtime = globalThis[TOPOLOGY_BOARD_VIEW_RUNTIME];
  if (!runtime || typeof runtime.projectBoard !== "function"
    || typeof runtime.projectPath !== "function" || typeof runtime.hitTestBoard !== "function") {
    throw new Error("Topology board view support is unavailable. Load BoardView.js before rendering a topology board.");
  }
  return runtime;
}

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
  legalMoveFill: "#2fba63",
  legalMoveStroke: "rgba(17, 84, 40, 0.35)",
});

const PLAYER_THEME_KEYS = Object.freeze({
  BLACK: "blue", WHITE: "red", PURPLE: "purple",
  GREEN: "green", ORANGE: "orange", CYAN: "cyan",
});

const NODE_PLAYERS = new Map(PLAYER_ORDER.map((player) => [PointState[`${player}_NODE`], player]));
const LINE_PLAYERS = new Map(PLAYER_ORDER.map((player) => [PointState[`${player}_LINE`], player]));

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
    this._topologyProjection = null;
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
    // Keep lightweight legacy renderer probes structurally unchanged; real
    // Renderer instances initialize this cache in the constructor.
    if (Object.hasOwn(this, "_topologyProjection")) this._topologyProjection = null;
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

  _topologyViewBoard(snapshot) {
    const topology = snapshot?.topology;
    const storedViewBoard = topology?.viewBoard;
    // Tests, replay inspectors and future atlas editors may supply a compact
    // display override at topology.*.  Only use it when it has explicit copy
    // IDs; ordinary engine snapshots retain the richer compiled view board.
    const hasExplicitCopies = Array.isArray(topology?.pointCopies)
      && topology.pointCopies.length > 0
      && topology.pointCopies.every((copy) => typeof copy?.id === "string");
    const viewBoard = storedViewBoard && typeof storedViewBoard === "object"
      ? {
        ...storedViewBoard,
        ...(hasExplicitCopies ? { pointCopies: topology.pointCopies } : {}),
        ...(Array.isArray(topology?.realBoundarySegments) ? { realBoundarySegments: topology.realBoundarySegments } : {}),
        ...(Array.isArray(topology?.seamPairs) ? { seamPairs: topology.seamPairs } : {}),
      }
      : topology;
    if (!viewBoard || !Array.isArray(viewBoard.pointCopies) || viewBoard.pointCopies.length === 0) {
      throw new Error("Topology snapshots require a non-empty topology.viewBoard atlas.");
    }
    return viewBoard;
  }

  _computeTopologyLayout(snapshot) {
    const cssWidth = this._lastMeasuredWidth > 0 ? this._lastMeasuredWidth : this._measureCanvas().cssWidth;
    const cssHeight = this._lastMeasuredHeight > 0 ? this._lastMeasuredHeight : this._measureCanvas().cssHeight;
    const topInset = clamp(this.topInset ?? 0, 0, Math.max(0, cssHeight - 1));
    const boardHeight = Math.max(1, cssHeight - topInset);
    const viewBoard = this._topologyViewBoard(snapshot);
    const chart = this._effectiveTopologyChart(snapshot);
    const normalizedPoints = viewBoard.pointCopies.filter(copy => this._topologyCopyVisible(copy, chart)).map((copy) => {
      const coordinate = copy?.coordinate;
      if (!Array.isArray(coordinate) || coordinate.length !== 2
        || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) {
        throw new Error("Topology atlas copies require finite two-dimensional coordinates.");
      }
      return [coordinate[0] + coordinate[1] * 0.5, coordinate[1] * SQRT3_OVER_2];
    });
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
    const layoutKey = JSON.stringify([
      "topology", snapshot?.boardHash ?? "", chart, cssWidth, cssHeight, topInset,
      minNX, maxNX, minNY, maxNY, this.paddingRatio,
    ]);
    this._renderCaches ??= new Map();
    const cachedLayout = this._renderCaches.get("topology-layout");
    if (cachedLayout?.key === layoutKey) return cachedLayout.value;

    const outerPadding = Math.max(12, Math.min(cssWidth, boardHeight) * this.paddingRatio);
    const usableWidth = Math.max(1, cssWidth - outerPadding * 2);
    const usableHeight = Math.max(1, boardHeight - outerPadding * 2);
    const logicalWidth = Math.max(1, maxNX - minNX);
    const logicalHeight = Math.max(1, maxNY - minNY);
    const scale = Math.min(usableWidth / (logicalWidth + 0.9), usableHeight / (logicalHeight + 0.9));
    const layout = {
      isTopologyLayout: true,
      cssWidth,
      cssHeight,
      topInset,
      scale,
      offsetX: (cssWidth - logicalWidth * scale) * 0.5 - minNX * scale,
      offsetY: topInset + (boardHeight - logicalHeight * scale) * 0.5 - minNY * scale,
      pointRadius: Math.max(5, scale * 0.13),
      guidePointRadius: Math.max(2, scale * 0.04),
      lineWidth: Math.max(3, scale * 0.08),
      guideLineWidth: Math.max(1, scale * 0.028),
      territoryLineWidth: Math.max(2, scale * 0.05),
      legalMoveRadius: Math.max(4, scale * 0.08),
      normalizedBounds: { minNX, maxNX, minNY, maxNY },
    };
    this._renderCaches.set("topology-layout", { key: layoutKey, value: layout });
    return layout;
  }

  _effectiveTopologyChart(snapshot) {
    return ["double-torus", "double-sphere"].includes(snapshot?.boardDefinition?.topology?.preset)
      && ["front", "back"].includes(this.topologyChart) ? this.topologyChart : "both";
  }

  _topologyCopyVisible(copy, chart) {
    if (chart === "both") return true;
    return (String(copy?.sourceVertexId ?? "").startsWith("back:") ? "back" : "front") === chart;
  }

  setTopologyChart(chart = "both") {
    if (!["both", "front", "back"].includes(chart)) throw new TypeError("Invalid topology chart.");
    this.topologyChart = chart;
    this._topologyProjection = null;
    this._lastRenderFingerprint = "";
    if (this.lastSnapshot?.isTopologyBoard) this.render(this.lastSnapshot, { _immediate: true, force: true, skipResize: true });
  }

  _getTopologyProjection(snapshot, layout) {
    const viewBoard = this._topologyViewBoard(snapshot);
    const chart = this._effectiveTopologyChart(snapshot);
    const key = JSON.stringify([
      snapshot?.boardHash ?? "", chart, layout.cssWidth, layout.cssHeight,
      layout.scale, layout.offsetX, layout.offsetY,
    ]);
    if (this._topologyProjection?.key === key) return this._topologyProjection.value;
    const runtime = getTopologyBoardViewRuntime();
    const fullProjected = runtime.projectBoard(viewBoard, {
      scale: layout.scale,
      offset: [layout.offsetX, layout.offsetY],
    });
    const pointCopies = fullProjected.pointCopies.filter(copy => this._topologyCopyVisible(copy, chart));
    const visibleCopyIds = new Set(pointCopies.map(copy => copy.id));
    const projected = { ...fullProjected, pointCopies,
      boundarySegments: fullProjected.boundarySegments.filter(segment => visibleCopyIds.has(segment.fromCopyId) && visibleCopyIds.has(segment.toCopyId)),
    };
    const byCopyId = new Map(projected.pointCopies.map((copy) => [copy.id, copy]));
    const byCanonicalVertex = new Map();
    for (const copy of projected.pointCopies) {
      const copies = byCanonicalVertex.get(copy.canonicalVertexId) ?? [];
      copies.push(copy);
      byCanonicalVertex.set(copy.canonicalVertexId, copies);
    }
    const value = { runtime, viewBoard, projected, byCopyId, byCanonicalVertex, visibleCopyIds, chart };
    this._topologyProjection = { key, value };
    return value;
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
    if (typeof gx === "string" && this.lastSnapshot?.isTopologyBoard) {
      if (!this.layout) this.layout = this._computeTopologyLayout(this.lastSnapshot);
      const projection = this._getTopologyProjection(this.lastSnapshot, this.layout);
      const copy = projection.byCopyId.get(gx)
        ?? projection.byCanonicalVertex.get(gx)?.[0];
      if (!copy) throw new Error("Unknown topology vertex or atlas copy: " + gx);
      return { x: copy.x, y: copy.y };
    }
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
      this.layout = snapshot.isTopologyBoard
        ? this._computeTopologyLayout(snapshot)
        : this._computeLayout(snapshot);
    }
    // Pick the nearest grid point within almost one triangular grid cell.
    // Input still checks that exact point's legality, never a nearby legal move.
    return Math.max(12, this.layout.scale * 0.58);
  }

  /** Return a canonical topology vertex ID for a canvas-space click, if any. */
  getTopologyHitVertexId(pixelX, pixelY) {
    if (!this.lastSnapshot?.isTopologyBoard) return null;
    if (!this.layout) this.layout = this._computeTopologyLayout(this.lastSnapshot);
    const projection = this._getTopologyProjection(this.lastSnapshot, this.layout);
    return projection.runtime.hitTestBoard(projection.projected, [pixelX, pixelY], {
      radius: this.getHitRadius(),
    });
  }

  _topologyCopiesForVertex(projection, vertexId) {
    return typeof vertexId === "string"
      ? (projection.byCanonicalVertex.get(vertexId) ?? [])
      : [];
  }

  _drawTopologyStatic(ctx, projection, layout) {
    ctx.clearRect(0, 0, layout.cssWidth, layout.cssHeight);
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, 0, layout.cssWidth, layout.cssHeight);

    // Atlas guide edges only join copies that occur in the same chart. A seam
    // is an identification marker, never a visible chord through the atlas.
    ctx.strokeStyle = this.theme.guideLine;
    ctx.lineWidth = layout.guideLineWidth;
    ctx.beginPath();
    for (const edge of projection.viewBoard.displayEdges ?? []) {
      const copyIds = edge?.copyIds ?? [edge?.fromCopyId, edge?.toCopyId];
      const copies = copyIds.map((copyId) => projection.byCopyId.get(copyId)).filter(Boolean);
      if (copies.length < 2) continue;
      ctx.moveTo(copies[0].x, copies[0].y);
      for (const copy of copies.slice(1)) ctx.lineTo(copy.x, copy.y);
    }
    ctx.stroke();

    ctx.strokeStyle = this.theme.boardStroke;
    ctx.lineWidth = Math.max(2, layout.guideLineWidth * 2);
    ctx.beginPath();
    for (const segment of projection.projected.boundarySegments ?? []) {
      ctx.moveTo(segment.from[0], segment.from[1]);
      ctx.lineTo(segment.to[0], segment.to[1]);
    }
    ctx.stroke();

    ctx.fillStyle = this.theme.guidePoint;
    ctx.beginPath();
    for (const copy of projection.projected.pointCopies ?? []) {
      ctx.moveTo(copy.x + layout.guidePointRadius, copy.y);
      ctx.arc(copy.x, copy.y, layout.guidePointRadius, 0, Math.PI * 2);
    }
    ctx.fill();

    for (const [markerIndex, marker] of (projection.projected.seamMarkers ?? []).entries()) {
      const anchors = marker.anchors ?? [];
      if (anchors.length < 4) continue;
      ctx.save();
      ctx.strokeStyle = this.theme.outline;
      ctx.fillStyle = this.theme.outline;
      ctx.lineWidth = Math.max(1.5, layout.guideLineWidth * 1.5);
      const endpointMap = marker.endpointMap ?? [0, 1];
      for (const [from, to] of [[anchors[0], anchors[1]], [anchors[2 + endpointMap[0]], anchors[2 + endpointMap[1]]]]) {
        if (projection.visibleCopyIds && (!projection.visibleCopyIds.has(from.copyId) || !projection.visibleCopyIds.has(to.copyId))) continue;
        const [x, y] = from.point;
        const [endX, endY] = to.point;
        const dx = endX - x, dy = endY - y;
        const length = Math.hypot(dx, dy) || 1;
        const ux = dx / length, uy = dy / length;
        ctx.setLineDash([Math.max(3, layout.scale * 0.08), Math.max(2, layout.scale * 0.05)]);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(endX, endY);
        ctx.stroke();
        ctx.setLineDash([]);
        const arrowX = x + dx * 0.65, arrowY = y + dy * 0.65;
        const arrowSize = Math.max(4, Math.min(9, length * 0.18));
        ctx.beginPath();
        ctx.moveTo(arrowX, arrowY);
        ctx.lineTo(arrowX - ux * arrowSize - uy * arrowSize * 0.55, arrowY - uy * arrowSize + ux * arrowSize * 0.55);
        ctx.moveTo(arrowX, arrowY);
        ctx.lineTo(arrowX - ux * arrowSize + uy * arrowSize * 0.55, arrowY - uy * arrowSize - ux * arrowSize * 0.55);
        ctx.stroke();
        ctx.font = "bold " + Math.max(10, layout.scale * 0.12) + "px sans-serif";
        ctx.fillText(String(markerIndex + 1), (x + endX) / 2 + uy * 10, (y + endY) / 2 - ux * 10);
      }
      ctx.restore();
    }
  }

  _ensureTopologyStaticLayer(snapshot, projection, layout) {
    if (!this._staticCtx) {
      this._staticLayerKey = "";
      return false;
    }
    const key = JSON.stringify([
      "topology-static",
      snapshot.boardHash ?? "",
      layout.cssWidth,
      layout.cssHeight,
      Math.round(layout.scale * 1000),
      layout.offsetX,
      layout.offsetY,
      this._lastMeasuredDpr ?? 1,
      projection.viewBoard,
      this.theme,
    ]);
    if (this._staticLayerKey === key) return true;
    this._drawTopologyStatic(this._staticCtx, projection, layout);
    this._staticLayerKey = key;
    return true;
  }

  _drawTopologyPaths(snapshot, projection, layout) {
    const pathsByPlayer = snapshot.topologyPaths ?? {};
    const ctx = this.ctx;
    for (const player of PLAYER_ORDER) {
      const connections = Array.isArray(pathsByPlayer[player]) ? pathsByPlayer[player] : [];
      if (!connections.length) continue;
      ctx.save();
      ctx.strokeStyle = this._getPlayerStyle(player, "Line");
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = layout.lineWidth;
      for (const connection of connections) {
        const segments = projection.runtime.projectPath(projection.viewBoard, connection, {
          scale: layout.scale,
          offset: [layout.offsetX, layout.offsetY],
        });
        for (const segment of segments) {
          if (!segment.points?.length || segment.points.length < 2 || (projection.visibleCopyIds && segment.copyIds?.some(id => !projection.visibleCopyIds.has(id)))) continue;
          ctx.beginPath();
          ctx.moveTo(segment.points[0][0], segment.points[0][1]);
          for (const point of segment.points.slice(1)) ctx.lineTo(point[0], point[1]);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  _drawTopologyTerritories(snapshot, projection, layout) {
    if (snapshot.territoryPending) return;
    const ctx = this.ctx;
    const runtime = projection.runtime ?? getTopologyBoardViewRuntime();
    const geometry = runtime.buildTopologyTerritoryDisplay(snapshot).filter(part => !projection.chart || projection.chart === "both"
      || (typeof part.faceId === "string" && (part.faceId.startsWith("back:") ? "back" : "front") === projection.chart));
    for (const player of PLAYER_ORDER) {
      const faces = geometry.filter((part) => part.player === player && part.kind === "face");
      if (!faces.length) continue;
      ctx.save();
      ctx.beginPath();
      for (const { polygon } of faces) this._traceTerritory(ctx, polygon, layout);
      ctx.fillStyle = this._getPlayerStyle(player, "TerritoryFill");
      ctx.fill();
      ctx.restore();
    }
    for (const { player, polygon, kind } of geometry) {
      if (kind === "face") continue;
      ctx.save();
      ctx.beginPath();
      this._traceTerritory(ctx, polygon, layout);
      ctx.fillStyle = this._getPlayerStyle(player, "TerritoryFill");
      ctx.fill();
      ctx.strokeStyle = this._getPlayerStyle(player, "TerritoryStroke");
      ctx.lineWidth = layout.territoryLineWidth;
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawTopologyProtectionZones(snapshot, projection, layout) {
    const zones = snapshot.topology?.protectionZones ?? [];
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = Math.max(1.5, layout.guideLineWidth * 1.4);
    ctx.setLineDash([3, 3]);
    for (const zone of zones) {
      for (const [index, owner] of (zone.owners ?? []).entries()) {
        if (!PLAYER_ORDER.includes(owner)) continue;
        ctx.strokeStyle = this._getPlayerStyle(owner, "Line");
        for (const copy of this._topologyCopiesForVertex(projection, zone.canonicalVertexId)) {
          ctx.beginPath();
          ctx.arc(copy.x, copy.y, Math.max(layout.pointRadius + 3, layout.scale * 0.17) + index * 3, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  _drawTopologyLegalMoves(snapshot, projection, layout) {
    const candidates = Array.isArray(snapshot.legalMoves) ? snapshot.legalMoves : [];
    if (!candidates.length) return;
    const ctx = this.ctx;
    const radius = layout.legalMoveRadius;
    ctx.beginPath();
    for (const candidate of candidates) {
      const vertexId = typeof candidate === "string"
        ? candidate
        : candidate?.vertexId ?? candidate?.point;
      for (const copy of this._topologyCopiesForVertex(projection, vertexId)) {
        ctx.moveTo(copy.x, copy.y - radius);
        ctx.lineTo(copy.x + radius, copy.y);
        ctx.lineTo(copy.x, copy.y + radius);
        ctx.lineTo(copy.x - radius, copy.y);
        ctx.closePath();
      }
    }
    ctx.fillStyle = this.theme.legalMoveFill;
    ctx.fill();
    ctx.lineWidth = Math.max(1.25, layout.guideLineWidth * 1.8);
    ctx.strokeStyle = this.theme.legalMoveStroke;
    ctx.stroke();
  }

  _drawTopologyNodes(snapshot, projection, layout) {
    const boardStates = snapshot.boardStates ?? {};
    const ctx = this.ctx;
    ctx.lineWidth = Math.max(1.5, layout.lineWidth * 0.25);
    ctx.strokeStyle = this.theme.outline;
    for (const player of PLAYER_ORDER) {
      const nodeState = PointState[player + "_NODE"];
      const vertexIds = Object.entries(boardStates)
        .filter(([, state]) => state === nodeState)
        .map(([vertexId]) => vertexId);
      if (!vertexIds.length) continue;
      ctx.beginPath();
      for (const vertexId of vertexIds) {
        for (const copy of this._topologyCopiesForVertex(projection, vertexId)) {
          ctx.moveTo(copy.x + layout.pointRadius, copy.y);
          ctx.arc(copy.x, copy.y, layout.pointRadius, 0, Math.PI * 2);
        }
      }
      ctx.fillStyle = this._getPlayerStyle(player, "Node");
      ctx.fill();
      ctx.stroke();
    }
  }

  _drawTopologyStartingPoints(snapshot, projection, layout) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = Math.max(1.5, layout.lineWidth * 0.35);
    const roots = snapshot.topology?.startingRoots ?? snapshot.initialRoots
      ?? Object.fromEntries(Object.entries(snapshot.initialPositions ?? {}).map(([player, id]) => [player, [id]]));
    for (const [player, vertices] of Object.entries(roots)) {
      for (const vertexId of Array.isArray(vertices) ? vertices : [vertices]) {
       for (const copy of this._topologyCopiesForVertex(projection, vertexId)) {
        ctx.strokeStyle = this._getPlayerStyle(player, "Node");
        ctx.beginPath();
        ctx.arc(copy.x, copy.y, layout.pointRadius + 4, 0, Math.PI * 2);
        ctx.stroke();
       }
      }
    }
    ctx.restore();
  }

  _drawTopologyInspectionOverlay(snapshot, projection, layout) {
    const id = snapshot.inspectionOverlay?.selectedPoint;
    if (typeof id !== "string") return;
    const ctx = this.ctx;
    const radius = layout.pointRadius + Math.max(8, layout.scale * 0.18);
    for (const copy of this._topologyCopiesForVertex(projection, id)) {
      ctx.save();
      ctx.strokeStyle = "rgba(218, 151, 36, 0.98)";
      ctx.fillStyle = "rgba(255, 226, 117, 0.2)";
      ctx.lineWidth = Math.max(2.5, layout.lineWidth * 0.65);
      ctx.beginPath();
      ctx.arc(copy.x, copy.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawTopologyLatestMove(action, projection, layout) {
    if (!action || action.type !== "move" || typeof action.point !== "string"
      || !PLAYER_ORDER.includes(action.player)) return;
    const ctx = this.ctx;
    const stroke = this._getPlayerStyle(action.player, "Line");
    const ringRadius = layout.pointRadius + Math.max(6, layout.pointRadius * 0.55);
    const glowRadius = ringRadius + Math.max(5, layout.pointRadius * 0.7);
    for (const copy of this._topologyCopiesForVertex(projection, action.point)) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(copy.x, copy.y, glowRadius, 0, Math.PI * 2);
      ctx.fillStyle = stroke;
      ctx.globalAlpha = 0.22;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(copy.x, copy.y, ringRadius, 0, Math.PI * 2);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(2.5, layout.lineWidth * 0.3);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(copy.x, copy.y, Math.max(2.5, layout.pointRadius * 0.28), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
      ctx.fill();
      ctx.restore();
    }
  }

  _drawTopologyLastAction(snapshot, projection, layout) {
    const actions = snapshot.lastMoves !== undefined
      ? Object.entries(snapshot.lastMoves ?? {}).map(([player, point]) => ({ type: "move", player, point }))
      : [snapshot.lastAction];
    for (const action of actions) {
      if (snapshot.resignedPlayers?.includes(action?.player)
        || snapshot.boardStates?.[action?.point] !== PointState[`${action?.player}_NODE`]) continue;
      this._drawTopologyLatestMove(action, projection, layout);
    }
  }

  _doRenderTopology(snapshot, options = {}) {
    if (!options.skipResize) this.resize();
    this.layout = this._computeTopologyLayout(snapshot);
    const projection = this._getTopologyProjection(snapshot, this.layout);
    const fingerprint = [
      this._getBoardFingerprint(snapshot),
      "topology",
      projection.chart,
      this.layout.cssWidth,
      this.layout.cssHeight,
      this.layout.scale,
    ].join(":");
    if (!options.force && fingerprint === this._lastRenderFingerprint) return;
    this._lastRenderFingerprint = fingerprint;

    const hasStaticLayer = this._ensureTopologyStaticLayer(snapshot, projection, this.layout);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!hasStaticLayer) this._drawTopologyStatic(this.ctx, projection, this.layout);
    this._drawTopologyTerritories(snapshot, projection, this.layout);
    this._drawTopologyPaths(snapshot, projection, this.layout);
    this._drawTopologyProtectionZones(snapshot, projection, this.layout);
    this._drawTopologyLegalMoves(snapshot, projection, this.layout);
    this._drawTopologyNodes(snapshot, projection, this.layout);
    this._drawTopologyStartingPoints(snapshot, projection, this.layout);
    this._drawTopologyLastAction(snapshot, projection, this.layout);
    this._drawTopologyInspectionOverlay(snapshot, projection, this.layout);
    if (this._hintCtx) this._renderHintLayer();
    else this._drawHint(this.layout);
  }

  setHintPoint(point) {
    if (!point) {
      this.clearHintPoint();
      return;
    }

    this.hintPoint = typeof point === "string" ? point : [point[0], point[1]];
    this._hintPulsePhase = 0;
    this._lastHintTimestamp = 0;
    if (this._hintCtx) {
      if (!this.layout && this.lastSnapshot) {
        this.layout = this.lastSnapshot.isTopologyBoard
          ? this._computeTopologyLayout(this.lastSnapshot)
          : this._computeLayout(this.lastSnapshot);
      }
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

    const expandedCorners = this._getExpandedBoardCorners(layout);

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

  _getExpandedBoardCorners(layout) {
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
    return expandedCorners;
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
    // territories are visible. Never substitute the previous board's score cache.
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
      const mode = "polygon";
      const points = polygon;
      if (!points || points.length < 3) {
        continue;
      }
      if (points.reduce((sum, point, index) => {
        const next = points[(index + 1) % points.length];
        return sum + point[0] * next[1] - point[1] * next[0];
      }, 0) === 0) continue;

      ctx.save();
      this._territoryPaths ??= new Map();
      let path = null;
      if (this.cacheTerritoryPaths !== false && typeof Path2D === "function") {
        const cacheKey = JSON.stringify([
          mode,
          layout.scale,
          layout.pointRadius,
          layout.offsetX,
          layout.offsetY,
          points,
        ]);
        const cached = this._territoryPaths.get(territory.player);
        if (cached?.key === cacheKey) path = cached.path;
        else {
          path = new Path2D();
          this._traceTerritory(path, points, layout);
          this._territoryPaths.set(territory.player, {
            path,
            key: cacheKey,
          });
        }
      } else {
        ctx.beginPath();
        this._traceTerritory(ctx, points, layout);
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

  _drawProtectionZones(snapshot, layout) {
    const ctx = this.ctx;
    const directions = [[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];
    const zones = new Map();
    for (const [owner, root] of Object.entries(snapshot.initialPositions ?? {})) {
      if (!PLAYER_ORDER.includes(owner) || !Array.isArray(root)) continue;
      if (snapshot.protectionRule === "duel-first-unprotected-v1"
        && layout.playerCount === 2 && layout.boardShape === "triangle"
        && owner === snapshot.startPlayer) continue;
      for (const [dx, dy] of directions) {
        const point = [root[0] + dx, root[1] + dy];
        if (!isBoardPoint(point, layout.gridSize, layout.playerCount, layout.boardShape)) continue;
        const key = point.join(",");
        const zone = zones.get(key) ?? { point, owners: [] };
        zone.owners.push(owner);
        zones.set(key, zone);
      }
    }
    ctx.save();
    ctx.lineWidth = Math.max(1.5, layout.guideLineWidth * 1.4);
    ctx.setLineDash([3, 3]);
    for (const { point, owners } of zones.values()) {
      const [x, y] = this._gridToPixel(point[0], point[1], layout);
      for (const [index, owner] of owners.entries()) {
        ctx.strokeStyle = this._getPlayerStyle(owner, "Line");
        ctx.beginPath();
        ctx.arc(x, y, Math.max(layout.pointRadius + 3, layout.scale * 0.17) + index * 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _drawStartingPoints(snapshot, layout) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = Math.max(1.5, layout.lineWidth * 0.35);
    const rootsByPlayer = snapshot.roots ?? Object.fromEntries(
      Object.entries(snapshot.initialPositions ?? {}).map(([player, point]) => [player, [point]]),
    );
    for (const [player, roots] of Object.entries(rootsByPlayer)) {
      for (const point of roots) {
        ctx.strokeStyle = this._getPlayerStyle(player, "Node");
        ctx.globalAlpha = 0.28;
        ctx.setLineDash([Math.max(2, layout.lineWidth), Math.max(2, layout.lineWidth)]);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]]) {
          const protectedPoint = [point[0] + dx, point[1] + dy];
          if (!snapshot.boardMatrix?.[protectedPoint[1]] || snapshot.boardMatrix[protectedPoint[1]][protectedPoint[0]] == null) continue;
          const [px, py] = this._gridToPixel(protectedPoint[0], protectedPoint[1], layout);
          ctx.beginPath();
          ctx.arc(px, py, layout.pointRadius + 2, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
        const [x, y] = this._gridToPixel(point[0], point[1], layout);
        ctx.beginPath();
        ctx.arc(x, y, layout.pointRadius + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, layout.pointRadius + 7, 0, Math.PI * 2);
        ctx.stroke();
      }
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
    const actions = snapshot.lastMoves !== undefined
      ? Object.entries(snapshot.lastMoves ?? {}).map(([player, point]) => ({ type: "move", player, point }))
      : [snapshot.lastAction];
    for (const action of actions) {
      if (!action || action.type !== "move" || !Array.isArray(action.point) || action.point.length !== 2
        || !PLAYER_ORDER.includes(action.player)
        || !action.point.every(Number.isInteger)
        || snapshot.resignedPlayers?.includes(action.player)
        || snapshot.boardMatrix?.[action.point[1]]?.[action.point[0]] !== PointState[`${action.player}_NODE`]) continue;
      this._drawLatestMove(action, layout);
    }
  }

  _drawLatestMove(action, layout) {
    const ctx = this.ctx;
    const [x, y] = this._gridToPixel(action.point[0], action.point[1], layout);
    const stroke = this._getPlayerStyle(action.player, "Line");
    const ringRadius = layout.pointRadius + Math.max(6, layout.pointRadius * 0.55);
    const glowRadius = ringRadius + Math.max(5, layout.pointRadius * 0.7);

    ctx.save();
    // Separate paths prevent markers at different nodes from joining together.
    ctx.beginPath();
    ctx.arc(x, y, glowRadius, 0, Math.PI * 2);
    ctx.fillStyle = stroke;
    ctx.globalAlpha = 0.22;
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.arc(x, y, ringRadius, 0, Math.PI * 2);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(2.5, layout.lineWidth * 0.3);
    ctx.stroke();

    ctx.beginPath();
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
    if (snapshot?.isTopologyBoard) {
      const actionPoint = snapshot.lastAction?.point;
      return [
        "topology",
        snapshot.boardHash ?? "",
        snapshot.renderEpoch ?? 0,
        snapshot.positionRevision ?? snapshot.turnCount ?? 0,
        snapshot.gameOver ? 1 : 0,
        snapshot.territoryPending ? 1 : 0,
        snapshot.currentPlayer ?? "",
        typeof actionPoint === "string" ? actionPoint : JSON.stringify(actionPoint ?? null),
        JSON.stringify(snapshot.lastMoves ?? null),
        JSON.stringify(snapshot.boardStates ?? null),
        JSON.stringify(snapshot.topology?.startingRoots ?? snapshot.initialRoots ?? snapshot.initialPositions ?? null),
        JSON.stringify(snapshot.topologyPaths ?? null),
        JSON.stringify(snapshot.legalMoves ?? null),
        JSON.stringify(snapshot.territoryPending ? snapshot.renderTerritories : snapshot.territories),
        JSON.stringify(snapshot.topology?.viewBoard ?? snapshot.topology ?? null),
        JSON.stringify(snapshot.inspectionOverlay ?? null),
      ].join(":");
    }
    const lp = snapshot.lastAction?.point;
    return [
      snapshot.renderEpoch ?? 0,
      snapshot.positionRevision ?? snapshot.turnCount ?? 0,
      snapshot.playerCount ?? 2,
      snapshot.boardShape ?? "legacy",
      snapshot.rulesVersion ?? "territory-v1",
      snapshot.protectionRule ?? "symmetric-v1",
      snapshot.startPlayer ?? "BLACK",
      snapshot.gameOver ? 1 : 0,
      snapshot.territoryPending ? 1 : 0,
      snapshot.currentPlayer,
      snapshot.lastAction?.type ?? "none",
      snapshot.lastAction?.player ?? "none",
      lp ? `${lp[0]},${lp[1]}` : "-",
      JSON.stringify(snapshot.lastMoves ?? null),
      JSON.stringify(snapshot.inspectionOverlay ?? null),
      JSON.stringify(snapshot.initialPositions ?? null),
      // A same-revision snapshot can still carry a new preview, imported
      // board or legal-move list. These are display inputs, not rule state.
      JSON.stringify([snapshot.boardMatrix, snapshot.edges, snapshot.legalMoves,
        snapshot.territoryPending ? snapshot.renderTerritories : snapshot.territories]),
    ].join(":");
  }

  render(snapshot, options = {}) {
    if (!snapshot || (!snapshot.isTopologyBoard && !snapshot.boardMatrix)) {
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
    if (!snapshot || (!snapshot.isTopologyBoard && !snapshot.boardMatrix)) {
      return;
    }
    if (snapshot.isTopologyBoard) {
      this._doRenderTopology(snapshot, options);
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
    this._drawProtectionZones(snapshot, this.layout);
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
