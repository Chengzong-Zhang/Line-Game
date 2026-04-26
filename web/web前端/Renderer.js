import { Player, PointState } from "./GameEngine.js?v=20260421a";

const SQRT3_OVER_2 = Math.sqrt(3) / 2;

// Renderer 只负责把快照绘制到 Canvas，不做规则判断。
// 这样无论是本地模式还是联机回放，都能共享完全一致的渲染逻辑。

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
  blueTerritoryFill: "rgba(43, 111, 255, 0.18)",
  blueTerritoryStroke: "rgba(31, 79, 186, 0.75)",
  redTerritoryFill: "rgba(228, 75, 75, 0.18)",
  redTerritoryStroke: "rgba(168, 52, 52, 0.75)",
  purpleTerritoryFill: "rgba(139, 92, 246, 0.18)",
  purpleTerritoryStroke: "rgba(109, 40, 217, 0.75)",
  legalMoveFill: "#2fba63",
  legalMoveStroke: "rgba(17, 84, 40, 0.35)",
});

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
    this.paddingRatio = options.paddingRatio ?? 0.1;
    this.lastSnapshot = null;
    this.layout = null;
    this._resizeFrame = null;
    this._lastMeasuredWidth = 0;
    this._lastMeasuredHeight = 0;
    this._lastMeasuredDpr = 0;
    this._staticLayerKey = "";
    this._staticDomCanvas = null;
    this._staticCtx = null;
    this._pendingRafHandle = null;
    this._pendingOptions = {};
    this._lastRenderFingerprint = "";

    // 动态层（顶层）：透明背景，接收事件
    this.canvas.style.position = "absolute";
    this.canvas.style.top = "0";
    this.canvas.style.left = "0";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.background = "transparent";
    this.canvas.style.touchAction = "manipulation";

    // 静态层（底层）：绘制背景和棋盘骨架，不参与事件
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
    if (this._staticDomCanvas) {
      this._staticDomCanvas.remove();
      this._staticDomCanvas = null;
      this._staticCtx = null;
    }
    this._staticLayerKey = "";
  }

  _scheduleResize() {
    if (this._resizeFrame !== null) {
      return;
    }

    this._resizeFrame = globalThis.requestAnimationFrame(() => {
      this._resizeFrame = null;
      const resized = this.resize();
      if (resized && this.lastSnapshot) {
        // resize 已在 rAF 内，直接同步绘制，避免再多等一帧
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
    return true;
  }

  _measureCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(
      this.minCssWidth,
      Math.round(rect.width || this.canvas.clientWidth || this.canvas.width || this.defaultCssWidth),
    );
    const cssHeight = Math.max(
      this.minCssHeight,
      Math.round(rect.height || this.canvas.clientHeight || this.canvas.height || this.defaultCssHeight),
    );
    const prefersLowerDpr = globalThis.matchMedia?.("(pointer: coarse)")?.matches || window.innerWidth <= 768;
    const dpr = clamp(window.devicePixelRatio || 1, 1, prefersLowerDpr ? 2 : 3);

    return { cssWidth, cssHeight, dpr };
  }

  _getValidPoints(gridSize) {
    const points = [];
    for (let y = 0; y < gridSize; y += 1) {
      for (let x = 0; x < gridSize - y; x += 1) {
        points.push([x, y]);
      }
    }
    return points;
  }

  _computeLayout(snapshot) {
    // 优先复用 resize() 已测量并缓存的值，避免重复触发 getBoundingClientRect layout reflow
    const cssWidth = this._lastMeasuredWidth > 0 ? this._lastMeasuredWidth : this._measureCanvas().cssWidth;
    const cssHeight = this._lastMeasuredHeight > 0 ? this._lastMeasuredHeight : this._measureCanvas().cssHeight;
    const gridSize = snapshot?.gridSize ?? 9;
    const validPoints = this._getValidPoints(gridSize);
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

    const padding = Math.max(24, Math.min(cssWidth, cssHeight) * this.paddingRatio);
    const usableWidth = Math.max(1, cssWidth - padding * 2);
    const usableHeight = Math.max(1, cssHeight - padding * 2);
    const logicalWidth = Math.max(1, maxNX - minNX);
    const logicalHeight = Math.max(1, maxNY - minNY);
    const scale = Math.min(usableWidth / logicalWidth, usableHeight / logicalHeight);
    const offsetX = (cssWidth - logicalWidth * scale) * 0.5 - minNX * scale;
    const offsetY = (cssHeight - logicalHeight * scale) * 0.5 - minNY * scale;

    return {
      cssWidth,
      cssHeight,
      gridSize,
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
  }

  _gridToPixel(gx, gy, layout = this.layout) {
    if (!layout) {
      throw new Error("Layout is not available. Call render(snapshot) first.");
    }

    // Math.round 保证坐标落在整数像素，消除亚像素抗锯齿的 fillRate 开销
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
    return this.layout.pointRadius * 2;
  }

  _isValidGridPoint(point, gridSize) {
    const [x, y] = point;
    return y >= 0 && y < gridSize && x >= 0 && x < gridSize - y;
  }

  _canConnect(a, b) {
    return a[0] === b[0] || a[1] === b[1] || a[0] + a[1] === b[0] + b[1];
  }

  _getLinePoints(start, end, gridSize) {
    if (!this._canConnect(start, end)) {
      return [];
    }

    const [x1, y1] = start;
    const [x2, y2] = end;
    const points = [];

    if (x1 === x2) {
      for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y += 1) {
        const point = [x1, y];
        if (this._isValidGridPoint(point, gridSize)) {
          points.push(point);
        }
      }
      return points;
    }

    if (y1 === y2) {
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x += 1) {
        const point = [x, y1];
        if (this._isValidGridPoint(point, gridSize)) {
          points.push(point);
        }
      }
      return points;
    }

    const left = x1 < x2 ? [x1, y1] : [x2, y2];
    const right = x1 < x2 ? [x2, y2] : [x1, y1];
    for (let i = 0; i <= right[0] - left[0]; i += 1) {
      const point = [left[0] + i, left[1] - i];
      if (this._isValidGridPoint(point, gridSize)) {
        points.push(point);
      }
    }
    return points;
  }

  _getOwnedStates(player) {
    if (player === Player.BLACK) {
      return [PointState.BLACK_NODE, PointState.BLACK_LINE];
    }
    if (player === Player.WHITE) {
      return [PointState.WHITE_NODE, PointState.WHITE_LINE];
    }
    return [PointState.PURPLE_NODE, PointState.PURPLE_LINE];
  }

  _getNodeState(player) {
    if (player === Player.BLACK) {
      return PointState.BLACK_NODE;
    }
    if (player === Player.WHITE) {
      return PointState.WHITE_NODE;
    }
    return PointState.PURPLE_NODE;
  }

  _getLineState(player) {
    if (player === Player.BLACK) {
      return PointState.BLACK_LINE;
    }
    if (player === Player.WHITE) {
      return PointState.WHITE_LINE;
    }
    return PointState.PURPLE_LINE;
  }

  _collectBoardData(snapshot) {
    const gridSize = snapshot.gridSize;
    const board = snapshot.boardMatrix;
    const validPoints = this._getValidPoints(gridSize);
    const nodes = {
      [Player.BLACK]: [],
      [Player.WHITE]: [],
      [Player.PURPLE]: [],
    };

    for (const point of validPoints) {
      const [x, y] = point;
      const state = board[y][x];
      if (state === PointState.BLACK_NODE) {
        nodes[Player.BLACK].push(point);
      } else if (state === PointState.WHITE_NODE) {
        nodes[Player.WHITE].push(point);
      } else if (state === PointState.PURPLE_NODE) {
        nodes[Player.PURPLE].push(point);
      }
    }

    return {
      gridSize,
      validPoints,
      board,
      nodes,
    };
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

        const linePoints = this._getLinePoints(start, end, boardData.gridSize);
        // O(1) 二维数组索引，无字符串拼接/Map 查找
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

    return edgeKeys.map((edgeKey) => {
      const [startKey, endKey] = String(edgeKey).split("|");
      return [keyToPoint(startKey), keyToPoint(endKey)];
    });
  }

  _getStaticLayerKey(snapshot, layout) {
    return [
      snapshot?.gridSize ?? 9,
      layout.cssWidth,
      layout.cssHeight,
      Math.round(layout.scale * 1000),
      Math.round((this._lastMeasuredDpr || 1) * 10),
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

    // 直接绘制到底层 DOM canvas，无需离屏 blit
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

    const corners = [
      this._gridToPixel(0, 0, layout),
      this._gridToPixel(layout.gridSize - 1, 0, layout),
      this._gridToPixel(0, layout.gridSize - 1, layout),
    ];
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
    ctx.lineTo(expandedCorners[1][0], expandedCorners[1][1]);
    ctx.lineTo(expandedCorners[2][0], expandedCorners[2][1]);
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
        if (!this._isValidGridPoint(neighbor, boardData.gridSize)) {
          continue;
        }
        const [x1, y1] = this._gridToPixel(point[0], point[1], layout);
        const [x2, y2] = this._gridToPixel(neighbor[0], neighbor[1], layout);
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
    }
    ctx.stroke();

    // 将所有导引点合并为单次 fill()，避免 N 次单独 beginPath/fill 调用
    ctx.fillStyle = this.theme.guidePoint;
    ctx.beginPath();
    for (const point of boardData.validPoints) {
      const [x, y] = this._gridToPixel(point[0], point[1], layout);
      ctx.moveTo(x + layout.guidePointRadius, y);
      ctx.arc(x, y, layout.guidePointRadius, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  _drawSegments(snapshot, boardData, layout) {
    const ctx = this.ctx;
    const styles = {
      [Player.BLACK]: this.theme.blueLine,
      [Player.WHITE]: this.theme.redLine,
      [Player.PURPLE]: this.theme.purpleLine,
    };

    for (const player of [Player.BLACK, Player.WHITE, Player.PURPLE]) {
      const segments = this._getSnapshotSegments(snapshot, player)
        ?? this._collectRenderableSegments(player, boardData);
      if (!segments.length) {
        continue;
      }

      ctx.strokeStyle = styles[player];
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = layout.lineWidth;
      ctx.beginPath();

      for (const [start, end] of segments) {
        const [x1, y1] = this._gridToPixel(start[0], start[1], layout);
        const [x2, y2] = this._gridToPixel(end[0], end[1], layout);
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();
    }
  }

  _drawTerritories(snapshot, layout) {
    const ctx = this.ctx;
    const territories = [
      {
        data: snapshot.territories?.[Player.BLACK],
        fill: this.theme.blueTerritoryFill,
        stroke: this.theme.blueTerritoryStroke,
      },
      {
        data: snapshot.territories?.[Player.WHITE],
        fill: this.theme.redTerritoryFill,
        stroke: this.theme.redTerritoryStroke,
      },
      {
        data: snapshot.territories?.[Player.PURPLE],
        fill: this.theme.purpleTerritoryFill,
        stroke: this.theme.purpleTerritoryStroke,
      },
    ];

    for (const territory of territories) {
      const polygon = territory.data?.polygon;
      if (!polygon || polygon.length < 3) {
        continue;
      }

      ctx.save();
      ctx.beginPath();
      polygon.forEach(([gx, gy], index) => {
        const [x, y] = this._gridToPixel(gx, gy, layout);
        if (index === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.closePath();
      ctx.globalAlpha = 1;
      ctx.fillStyle = territory.fill;
      ctx.fill();
      ctx.strokeStyle = territory.stroke;
      ctx.lineWidth = layout.territoryLineWidth;
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawNodes(boardData, layout) {
    const ctx = this.ctx;
    const groups = [
      { points: boardData.nodes[Player.BLACK], fill: this.theme.blueNode },
      { points: boardData.nodes[Player.WHITE], fill: this.theme.redNode },
      { points: boardData.nodes[Player.PURPLE], fill: this.theme.purpleNode },
    ];

    ctx.lineWidth = Math.max(1.5, layout.lineWidth * 0.25);
    ctx.strokeStyle = this.theme.outline;
    for (const group of groups) {
      if (!group.points?.length) {
        continue;
      }

      ctx.beginPath();
      for (const point of group.points) {
        const [x, y] = this._gridToPixel(point[0], point[1], layout);
        ctx.moveTo(x + layout.pointRadius, y);
        ctx.arc(x, y, layout.pointRadius, 0, Math.PI * 2);
      }
      ctx.fillStyle = group.fill;
      ctx.fill();
      ctx.stroke();
    }
  }

  _drawLegalMoves(snapshot, layout) {
    const ctx = this.ctx;
    const legalMoves = Array.isArray(snapshot.legalMoves) ? snapshot.legalMoves : [];
    if (!legalMoves.length) {
      return;
    }

    const r = layout.legalMoveRadius;
    ctx.beginPath();
    for (const candidate of legalMoves) {
      const point = Array.isArray(candidate) ? candidate : candidate?.point;
      if (!Array.isArray(point) || point.length !== 2) {
        continue;
      }

      const [x, y] = this._gridToPixel(point[0], point[1], layout);
      // 菱形替代 arc，无三角函数开销
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
    }
    ctx.fillStyle = this.theme.legalMoveFill;
    ctx.fill();
    ctx.lineWidth = Math.max(1.25, layout.guideLineWidth * 1.8);
    ctx.strokeStyle = this.theme.legalMoveStroke;
    ctx.stroke();
  }

  _drawLastAction(snapshot, layout) {
    const action = snapshot?.lastAction;
    if (!action || action.type !== "move" || !Array.isArray(action.point) || action.point.length !== 2) {
      return;
    }

    const ctx = this.ctx;
    const playerColors = {
      [Player.BLACK]: this.theme.blueLine,
      [Player.WHITE]: this.theme.redLine,
      [Player.PURPLE]: this.theme.purpleLine,
    };
    const [x, y] = this._gridToPixel(action.point[0], action.point[1], layout);
    const stroke = playerColors[action.player] ?? this.theme.outline;

    const ringRadius = layout.pointRadius + Math.max(6, layout.pointRadius * 0.55);
    const glowRadius = ringRadius + Math.max(5, layout.pointRadius * 0.7);

    ctx.save();
    // 外层半透明实心圆模拟光晕（替代 shadowBlur，移动端性能更好）
    ctx.beginPath();
    ctx.arc(x, y, glowRadius, 0, Math.PI * 2);
    ctx.fillStyle = stroke;
    ctx.globalAlpha = 0.22;
    ctx.fill();
    ctx.globalAlpha = 1;

    // 描边光圈
    ctx.beginPath();
    ctx.arc(x, y, ringRadius, 0, Math.PI * 2);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(2.5, layout.lineWidth * 0.3);
    ctx.stroke();

    // 中心小白点
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2.5, layout.pointRadius * 0.28), 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
    ctx.fill();
    ctx.restore();
  }

  _getBoardFingerprint(snapshot) {
    // 用于脏检查：覆盖棋盘状态的所有可见变化
    const lp = snapshot.lastAction?.point;
    return `${snapshot.turnCount}:${snapshot.gameOver ? 1 : 0}:${snapshot.currentPlayer}:${lp ? `${lp[0]},${lp[1]}` : '-'}`;
  }

  render(snapshot, options = {}) {
    if (!snapshot || !snapshot.boardMatrix) {
      throw new Error("Renderer.render(snapshot) requires a valid GameEngine snapshot.");
    }
    this.lastSnapshot = snapshot;

    // _immediate 由内部 resize 路径使用，此时已在 rAF 内，直接绘制
    if (options._immediate) {
      this._doRender(snapshot, options);
      return;
    }

    // 将同一帧内的多次 render 调用合并为一次，始终取最新快照
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

    const boardData = this._collectBoardData(snapshot);
    this._ensureStaticLayer(snapshot, boardData, this.layout);

    // 脏检查：静态层 key 变化（resize/gridSize 改变）也需要重绘动态层
    const fingerprint = `${this._getBoardFingerprint(snapshot)}:${this._staticLayerKey}`;
    if (fingerprint === this._lastRenderFingerprint) {
      return;
    }
    this._lastRenderFingerprint = fingerprint;

    // 只清除动态层（顶层），静态层（底层 DOM canvas）持久保存，无需每帧 blit
    if (this._staticCtx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    } else {
      // 无静态层时降级：在主 canvas 上直接绘制背景和骨架
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this._drawBackground(this.layout);
      this._drawGridSkeleton(boardData, this.layout);
    }
    this._drawSegments(snapshot, boardData, this.layout);
    this._drawTerritories(snapshot, this.layout);
    this._drawLegalMoves(snapshot, this.layout);
    this._drawNodes(boardData, this.layout);
    this._drawLastAction(snapshot, this.layout);
  }
}

export default Renderer;
