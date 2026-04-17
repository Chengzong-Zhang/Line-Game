import { Player, PointState } from "./GameEngine.js?v=20260417b";

const SQRT3_OVER_2 = Math.sqrt(3) / 2;

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
  blueTerritoryFill: "rgba(43, 111, 255, 0.18)",
  blueTerritoryStroke: "rgba(31, 79, 186, 0.75)",
  redTerritoryFill: "rgba(228, 75, 75, 0.18)",
  redTerritoryStroke: "rgba(168, 52, 52, 0.75)",
  legalMoveFill: "#2fba63",
  legalMoveStroke: "rgba(17, 84, 40, 0.35)",
});

function pointKey(point) {
  return `${point[0]},${point[1]}`;
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
    this.minCssWidth = options.minCssWidth ?? 320;
    this.minCssHeight = options.minCssHeight ?? 320;
    this.defaultCssWidth = options.defaultCssWidth ?? 960;
    this.defaultCssHeight = options.defaultCssHeight ?? 720;
    this.paddingRatio = options.paddingRatio ?? 0.1;
    this.lastSnapshot = null;
    this.layout = null;

    this.canvas.style.display = "block";
    this.canvas.style.width = this.canvas.style.width || "100%";
    this.canvas.style.height = this.canvas.style.height || "100%";
    this.canvas.style.touchAction = "manipulation";

    this._resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          this.resize();
          if (this.lastSnapshot) {
            this.render(this.lastSnapshot);
          }
        })
      : null;

    if (this._resizeObserver) {
      this._resizeObserver.observe(this.canvas);
      if (this.canvas.parentElement) {
        this._resizeObserver.observe(this.canvas.parentElement);
      }
    }

    this.resize();
  }

  destroy() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
    }
  }

  resize() {
    const { cssWidth, cssHeight, dpr } = this._measureCanvas();

    if (this.canvas.width !== Math.round(cssWidth * dpr) || this.canvas.height !== Math.round(cssHeight * dpr)) {
      this.canvas.width = Math.round(cssWidth * dpr);
      this.canvas.height = Math.round(cssHeight * dpr);
    }

    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
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
    const dpr = clamp(window.devicePixelRatio || 1, 1, 4);

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
    const { cssWidth, cssHeight } = this._measureCanvas();
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

    const x = layout.offsetX + (gx + gy * 0.5) * layout.scale;
    const y = layout.offsetY + gy * SQRT3_OVER_2 * layout.scale;
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
    return player === Player.BLACK
      ? [PointState.BLACK_NODE, PointState.BLACK_LINE]
      : [PointState.WHITE_NODE, PointState.WHITE_LINE];
  }

  _getNodeState(player) {
    return player === Player.BLACK ? PointState.BLACK_NODE : PointState.WHITE_NODE;
  }

  _getLineState(player) {
    return player === Player.BLACK ? PointState.BLACK_LINE : PointState.WHITE_LINE;
  }

  _collectBoardData(snapshot) {
    const gridSize = snapshot.gridSize;
    const board = snapshot.boardMatrix;
    const validPoints = this._getValidPoints(gridSize);
    const nodes = {
      [Player.BLACK]: [],
      [Player.WHITE]: [],
    };
    const pointStates = new Map();

    for (const point of validPoints) {
      const [x, y] = point;
      const state = board[y][x];
      pointStates.set(pointKey(point), state);
      if (state === PointState.BLACK_NODE) {
        nodes[Player.BLACK].push(point);
      } else if (state === PointState.WHITE_NODE) {
        nodes[Player.WHITE].push(point);
      }
    }

    return {
      gridSize,
      validPoints,
      pointStates,
      nodes,
    };
  }

  _collectRenderableSegments(player, boardData) {
    const nodeState = this._getNodeState(player);
    const ownedStates = new Set(this._getOwnedStates(player));
    const playerNodes = boardData.nodes[player];
    const segments = [];

    for (let i = 0; i < playerNodes.length; i += 1) {
      for (let j = i + 1; j < playerNodes.length; j += 1) {
        const start = playerNodes[i];
        const end = playerNodes[j];
        if (!this._canConnect(start, end)) {
          continue;
        }

        const linePoints = this._getLinePoints(start, end, boardData.gridSize);
        const fullyOwned = linePoints.every((point) => ownedStates.has(boardData.pointStates.get(pointKey(point))));
        if (!fullyOwned) {
          continue;
        }

        const hasIntermediateNode = linePoints.some((point) => {
          if (pointEquals(point, start) || pointEquals(point, end)) {
            return false;
          }
          return boardData.pointStates.get(pointKey(point)) === nodeState;
        });
        if (hasIntermediateNode) {
          continue;
        }

        segments.push([start, end]);
      }
    }

    return segments;
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

    ctx.fillStyle = this.theme.guidePoint;
    for (const point of boardData.validPoints) {
      const [x, y] = this._gridToPixel(point[0], point[1], layout);
      ctx.beginPath();
      ctx.arc(x, y, layout.guidePointRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawSegments(snapshot, boardData, layout) {
    const ctx = this.ctx;
    const styles = {
      [Player.BLACK]: this.theme.blueLine,
      [Player.WHITE]: this.theme.redLine,
    };

    for (const player of [Player.BLACK, Player.WHITE]) {
      const segments = this._collectRenderableSegments(player, boardData);
      ctx.strokeStyle = styles[player];
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = layout.lineWidth;

      for (const [start, end] of segments) {
        const [x1, y1] = this._gridToPixel(start[0], start[1], layout);
        const [x2, y2] = this._gridToPixel(end[0], end[1], layout);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
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
    const nodeStyles = {
      [PointState.BLACK_NODE]: {
        fill: this.theme.blueNode,
        stroke: this.theme.outline,
      },
      [PointState.WHITE_NODE]: {
        fill: this.theme.redNode,
        stroke: this.theme.outline,
      },
    };

    for (const point of boardData.validPoints) {
      const state = boardData.pointStates.get(pointKey(point));
      const style = nodeStyles[state];
      if (!style) {
        continue;
      }

      const [x, y] = this._gridToPixel(point[0], point[1], layout);
      ctx.beginPath();
      ctx.arc(x, y, layout.pointRadius, 0, Math.PI * 2);
      ctx.fillStyle = style.fill;
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, layout.lineWidth * 0.25);
      ctx.strokeStyle = style.stroke;
      ctx.stroke();
    }
  }

  _drawLegalMoves(snapshot, layout) {
    const ctx = this.ctx;
    const legalMoves = Array.isArray(snapshot.legalMoves) ? snapshot.legalMoves : [];

    for (const candidate of legalMoves) {
      const point = Array.isArray(candidate) ? candidate : candidate?.point;
      if (!Array.isArray(point) || point.length !== 2) {
        continue;
      }

      const [x, y] = this._gridToPixel(point[0], point[1], layout);
      ctx.beginPath();
      ctx.arc(x, y, layout.legalMoveRadius, 0, Math.PI * 2);
      ctx.fillStyle = this.theme.legalMoveFill;
      ctx.fill();
      ctx.lineWidth = Math.max(1.25, layout.guideLineWidth * 1.8);
      ctx.strokeStyle = this.theme.legalMoveStroke;
      ctx.stroke();
    }
  }

  render(snapshot) {
    if (!snapshot || !snapshot.boardMatrix) {
      throw new Error("Renderer.render(snapshot) requires a valid GameEngine snapshot.");
    }

    this.lastSnapshot = snapshot;
    this.resize();
    this.layout = this._computeLayout(snapshot);

    const boardData = this._collectBoardData(snapshot);
    this._drawBackground(this.layout);
    this._drawGridSkeleton(boardData, this.layout);
    this._drawSegments(snapshot, boardData, this.layout);
    this._drawTerritories(snapshot, this.layout);
    this._drawLegalMoves(snapshot, this.layout);
    this._drawNodes(boardData, this.layout);
  }
}

export default Renderer;
