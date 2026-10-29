import { hitTestBoard, projectBoard, projectPath } from './core.js';
import { PLAYER_COLORS, PLAYER_CONTRAST_COLORS } from './display.js';
import { buildTopologyTerritoryDisplay } from './topology/TerritoryDisplay.js';

// This adapter deliberately consumes the immutable topology view model rather
// than reconstructing topology from Canvas pixels.  A point copy is only a
// chart drawing location: all input and rule-facing identifiers remain the
// canonical vertex IDs returned by BoardView.
const SQRT3_OVER_2 = Math.sqrt(3) / 2;
const PLAYER_ORDER = ['BLACK', 'WHITE', 'PURPLE', 'GREEN', 'ORANGE', 'CYAN'];

function requireRect(rect) {
  if (!rect || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key]))
    || rect.width <= 0 || rect.height <= 0) {
    throw new TypeError('A topology layout requires a positive finite canvas rectangle.');
  }
  return rect;
}

function normalizedPadding(value) {
  return Number.isFinite(value) && value >= 0 ? value : 18;
}

function copyMap(projected) {
  return new Map((projected?.pointCopies ?? []).map((copy) => [copy.id, copy]));
}

function canonicalMap(projected) {
  const result = new Map();
  for (const copy of projected?.pointCopies ?? []) {
    const copies = result.get(copy.canonicalVertexId) ?? [];
    copies.push(copy);
    result.set(copy.canonicalVertexId, copies);
  }
  return result;
}

function axialPoint(coordinate) {
  return [coordinate[0] + coordinate[1] * 0.5, coordinate[1] * SQRT3_OVER_2];
}

function drawPolyline(ctx, points, color, width = 1, dash = null) {
  if (!Array.isArray(points) || points.length < 2) return;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (dash && typeof ctx.setLineDash === 'function') ctx.setLineDash(dash);
  points.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.stroke();
  if (dash && typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
}

function drawDisc(ctx, point, radius, color, outline = null) {
  ctx.beginPath();
  ctx.arc(point[0], point[1], radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  if (outline) {
    ctx.strokeStyle = outline;
    ctx.lineWidth = Math.max(1, radius * 0.2);
    ctx.stroke();
  }
}

function drawRing(ctx, point, radius, color) {
  ctx.beginPath();
  ctx.arc(point[0], point[1], radius, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, radius * 0.2);
  ctx.stroke();
}

function drawArrow(ctx, from, to, color, width) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (!(length > 0.001)) return;
  const ux = dx / length;
  const uy = dy / length;
  const head = Math.min(9, Math.max(4, width * 3));
  drawPolyline(ctx, [from, to], color, width, [3, 3]);
  const left = [to[0] - ux * head - uy * head * 0.55, to[1] - uy * head + ux * head * 0.55];
  const right = [to[0] - ux * head + uy * head * 0.55, to[1] - uy * head - ux * head * 0.55];
  drawPolyline(ctx, [left, to, right], color, width);
}

function playerForState(state) {
  if (!Number.isInteger(state) || state <= 0) return null;
  return PLAYER_ORDER[Math.floor((state - 1) / 2)] ?? null;
}

function isNodeState(state) {
  return Number.isInteger(state) && state > 0 && state % 2 === 1;
}

function identifier(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.vertexId === 'string') return value.vertexId;
  if (value && typeof value.point === 'string') return value.point;
  return null;
}

function projectedSegments(viewBoard, projected, listName) {
  const byCopyId = copyMap(projected);
  return (viewBoard?.[listName] ?? []).map((entry) => {
    const points = (entry.copyIds ?? []).map((id) => byCopyId.get(id)).filter(Boolean)
      .map((copy) => [copy.x, copy.y]);
    return { entry, points };
  }).filter(({ points }) => points.length >= 2);
}

function drawTopologyTerritory(ctx, snapshot, colors, layout) {
  if (snapshot.territoryPending) return;
  for (const region of buildTopologyTerritoryDisplay(snapshot)) {
    if (!Array.isArray(region.polygon) || region.polygon.length < 3) continue;
    const points = region.polygon.map(coordinate => {
      const [x, y] = axialPoint(coordinate);
      return [x * layout.scale + layout.viewOptions.offset[0], y * layout.scale + layout.viewOptions.offset[1]];
    });
    if (typeof ctx.save === 'function') ctx.save();
    if ('globalAlpha' in ctx) ctx.globalAlpha = 0.2;
    ctx.fillStyle = colors[region.player] ?? '#627661'; ctx.beginPath();
    points.forEach((point, i) => i ? ctx.lineTo(point[0], point[1]) : ctx.moveTo(point[0], point[1]));
    ctx.closePath(); ctx.fill();
    if (typeof ctx.restore === 'function') ctx.restore();
  }
}

function drawTopologyPaths(ctx, snapshot, viewBoard, viewOptions, colors, scale) {
  for (const player of snapshot.players ?? []) {
    for (const connection of snapshot.topologyPaths?.[player] ?? []) {
      // projectPath uses source copy IDs only as chart metadata.  The logical
      // path itself continues to be keyed by canonical vertex IDs.
      for (const segment of projectPath(viewBoard, connection, viewOptions)) {
        drawPolyline(ctx, segment.points, colors[player] ?? '#244d3d', Math.max(2, scale * 0.075));
      }
    }
  }
}

/**
 * Project a topology board into a native Canvas rectangle.  The returned
 * layout is also the only accepted input to hitTopologyVertex, making it
 * impossible for callers to translate an atlas copy into a raw source ID.
 */
export function layoutTopologyBoard(snapshot, rect, options = {}) {
  requireRect(rect);
  const viewBoard = snapshot?.topology?.viewBoard;
  if (!viewBoard || typeof viewBoard !== 'object') {
    throw new TypeError('A topology snapshot needs topology.viewBoard.');
  }
  const raw = projectBoard(viewBoard);
  if (!raw.pointCopies.length) throw new TypeError('A topology view needs at least one point copy.');
  const padding = Math.min(normalizedPadding(options.padding), Math.min(rect.width, rect.height) / 2);
  const xs = raw.pointCopies.map((copy) => copy.x);
  const ys = raw.pointCopies.map((copy) => copy.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const rangeX = Math.max(1, maxX - minX);
  const rangeY = Math.max(1, maxY - minY);
  const availableWidth = Math.max(1, rect.width - padding * 2);
  const availableHeight = Math.max(1, rect.height - padding * 2);
  const scale = Math.min(availableWidth / rangeX, availableHeight / rangeY);
  const contentWidth = (maxX - minX) * scale;
  const contentHeight = (maxY - minY) * scale;
  const offset = [rect.x + padding + (availableWidth - contentWidth) / 2 - minX * scale,
    rect.y + padding + (availableHeight - contentHeight) / 2 - minY * scale];
  const viewOptions = { scale, offset };
  const projected = projectBoard(viewBoard, viewOptions);
  return Object.freeze({
    contractVersion: projected.contractVersion,
    rect: { ...rect },
    padding,
    scale,
    viewBoard,
    viewOptions: Object.freeze(viewOptions),
    projected,
    pointCopiesById: copyMap(projected),
    copiesByCanonicalVertex: canonicalMap(projected),
    hitRadius: Number.isFinite(options.hitRadius) && options.hitRadius >= 0
      ? options.hitRadius : Math.max(15, Math.min(30, scale * 0.32)),
  });
}

/** Return a canonical vertex ID or null; never return an atlas/source ID. */
export function hitTopologyVertex(x, y, layout, options = {}) {
  if (!layout?.projected || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const radius = Number.isFinite(options.radius) && options.radius >= 0 ? options.radius : layout.hitRadius;
  return hitTestBoard(layout.projected, [x, y], { radius });
}

export function drawTopologyBoard(ctx, snapshot, layout, {
  selected = null,
  hint = null,
  target = null,
  lastMove = null,
  effects = null,
  display = {},
} = {}) {
  if (!ctx || typeof ctx.beginPath !== 'function' || !layout?.projected) {
    throw new TypeError('A Canvas context and topology layout are required.');
  }
  // A state update clones its snapshot, so object identity is not a stable
  // board identity.  The layout's view board is frozen at match creation;
  // dynamic pieces below still come from the current snapshot.
  const viewBoard = layout.viewBoard;
  const colors = display.highContrast ? PLAYER_CONTRAST_COLORS : PLAYER_COLORS;
  const projected = layout.projected;
  const canonicalCopies = layout.copiesByCanonicalVertex ?? canonicalMap(projected);
  const scale = layout.scale;

  // 1. Guide edges are only chart-local geometry, never a rule source.
  for (const { points } of projectedSegments(viewBoard, projected, 'displayEdges')) {
    drawPolyline(ctx, points, '#d8cfbd', Math.max(0.7, scale * 0.028));
  }
  // 2. Discrete territory comes from the canonical score output.
  if (display.territories !== false) drawTopologyTerritory(ctx, snapshot, colors, layout);
  // 3. Logical paths split at seams through BoardView.projectPath.
  drawTopologyPaths(ctx, snapshot, viewBoard, layout.viewOptions, colors, scale);
  if (effects) {
    for (const [player, paths] of Object.entries(snapshot.topologyPaths ?? {})) {
      const added = new Set(effects.addedEdgesByPlayer?.[player] ?? []);
      for (const path of paths) if (added.has(path.pathId)) {
        for (const segment of projectPath(viewBoard, path, layout.viewOptions))
          drawPolyline(ctx, segment.points, colors[player] ?? '#244d3d', Math.max(2, scale * 0.11), [5, 3]);
      }
    }
    for (const id of effects.capturedPoints ?? []) for (const copy of canonicalCopies.get(id) ?? [])
      drawRing(ctx, [copy.x, copy.y], Math.max(5, scale * 0.18), '#ca6a36');
  }
  // 4. Real boundaries are the unglued edges, not the screen cut.
  for (const segment of projected.boundarySegments) {
    drawPolyline(ctx, [segment.from, segment.to], '#9f6946', Math.max(1.2, scale * 0.055));
  }
  // 5. Seam arrows make endpoint pairings visible without changing movement.
  for (const [seamIndex, marker] of projected.seamMarkers.entries()) {
    const endpointMap = marker.endpointMap ?? [0, 1];
    for (const offset of [0, 2]) {
      const a = marker.anchors[offset]?.point, b = marker.anchors[offset + 1]?.point;
      if (!a || !b) continue;
      drawPolyline(ctx, [a, b], '#8a5a9b', Math.max(1.2, scale * 0.05), [4, 3]);
      if (typeof ctx.fillText === 'function') {
        ctx.fillStyle = '#6d397b'; ctx.font = `${Math.max(10, Math.min(15, scale * 0.25))}px sans-serif`;
        ctx.fillText(String(seamIndex + 1), (a[0] + b[0]) / 2 + 3, (a[1] + b[1]) / 2 - 3);
      }
    }
    for (let index = 0; index < 2; index += 1) {
      const from = marker.anchors[index]?.point;
      const to = marker.anchors[2 + endpointMap[index]]?.point;
      if (from && to) drawArrow(ctx, from, to, '#8a5a9b', Math.max(1, scale * 0.04));
    }
  }
  // 6. Legal moves are canonical ID-labelled engine results.
  if (display.legalMoves !== false && !snapshot.gameOver) {
    const legal = new Set((snapshot.legalMoves ?? []).map(identifier).filter(Boolean));
    for (const vertexId of legal) for (const copy of canonicalCopies.get(vertexId) ?? []) {
      drawDisc(ctx, [copy.x, copy.y], Math.max(1.3, scale * 0.075), '#8ab397');
    }
  }
  // 7. Nodes are painted after paths so the endpoint remains legible.
  for (const [vertexId, state] of Object.entries(snapshot.boardStates ?? {})) {
    if (!isNodeState(state)) continue;
    const player = playerForState(state);
    for (const copy of canonicalCopies.get(vertexId) ?? []) {
      drawDisc(ctx, [copy.x, copy.y], Math.max(3.5, scale * 0.14), colors[player] ?? '#244d3d', '#fffdf7');
    }
  }
  // 8. Rings are visual affordances over all chart copies of the same point.
  for (const [value, color] of [[lastMove, '#fffdf7'], [hint, '#6f974b'], [target, '#cda04d'], [selected, '#244d3d']]) {
    const vertexId = identifier(value);
    if (!vertexId) continue;
    for (const copy of canonicalCopies.get(vertexId) ?? []) {
      drawRing(ctx, [copy.x, copy.y], Math.max(7, scale * 0.27), color);
    }
  }
  return layout;
}

export function layoutTopologyDraft(draft, rect, options = {}) {
  requireRect(rect);
  const path = Array.isArray(draft?.path) ? draft.path : [];
  const points = path.map((coordinate, index) => {
    if (!Array.isArray(coordinate) || coordinate.length !== 2 || !coordinate.every(Number.isFinite)) {
      throw new TypeError('Every topology draft coordinate must be finite.');
    }
    const [x, y] = axialPoint(coordinate);
    return { index, coordinate: [...coordinate], x, y };
  });
  const gridSize = Number.isInteger(options.gridSize) && options.gridSize >= 2 && options.gridSize <= 31 ? options.gridSize : null;
  const grid = [];
  if (gridSize) for (let q = 0; q < gridSize; q++) for (let r = 0; r < gridSize; r++) {
    const coordinate = [q, r], [x, y] = axialPoint(coordinate);
    const index = points.findIndex(point => point.coordinate[0] === q && point.coordinate[1] === r);
    grid.push({ coordinate, index: index < 0 ? null : index, x, y });
  }
  const padding = Math.min(normalizedPadding(options.padding), Math.min(rect.width, rect.height) / 2);
  const extent = gridSize ? [...grid, ...points] : points;
  const xs = extent.map((point) => point.x);
  const ys = extent.map((point) => point.y);
  const minX = xs.length ? Math.min(...xs) : 0, maxX = xs.length ? Math.max(...xs) : 1;
  const minY = ys.length ? Math.min(...ys) : 0, maxY = ys.length ? Math.max(...ys) : 1;
  const scale = Math.min(Math.max(1, rect.width - padding * 2) / Math.max(1, maxX - minX),
    Math.max(1, rect.height - padding * 2) / Math.max(1, maxY - minY));
  const offset = [rect.x + padding + (Math.max(1, rect.width - padding * 2) - (maxX - minX) * scale) / 2 - minX * scale,
    rect.y + padding + (Math.max(1, rect.height - padding * 2) - (maxY - minY) * scale) / 2 - minY * scale];
  return Object.freeze({
    rect: { ...rect },
    scale,
    padding,
    points: points.map((point) => ({ ...point, x: point.x * scale + offset[0], y: point.y * scale + offset[1] })),
    gridPoints: grid.map((point) => ({ ...point, x: point.x * scale + offset[0], y: point.y * scale + offset[1] })),
    closed: Boolean(draft?.closed),
    hitRadius: Number.isFinite(options.hitRadius) && options.hitRadius >= 0 ? options.hitRadius : Math.max(15, scale * 0.25),
  });
}

export function hitTopologyDraftPoint(x, y, layout, options = {}) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !layout?.points) return null;
  const radius = Number.isFinite(options.radius) && options.radius >= 0 ? options.radius : layout.hitRadius;
  let nearest = null;
  for (const point of layout.gridPoints?.length ? layout.gridPoints : layout.points) {
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance <= radius && (!nearest || distance < nearest.distance)) nearest = { point, distance };
  }
  return nearest ? { index: nearest.point.index, coordinate: [...nearest.point.coordinate] } : null;
}

export function drawTopologyDraft(ctx, draft, layout, { selectedIndex = null, previewCoordinate = null } = {}) {
  if (!ctx || typeof ctx.beginPath !== 'function' || !layout?.points) {
    throw new TypeError('A Canvas context and topology draft layout are required.');
  }
  if (layout.gridPoints?.length) {
    const grid = new Map(layout.gridPoints.map(point => [point.coordinate.join(','), point]));
    for (const point of layout.gridPoints) {
      for (const [dq, dr] of [[1, 0], [0, 1], [1, -1]]) {
        const next = grid.get(`${point.coordinate[0] + dq},${point.coordinate[1] + dr}`);
        if (next) drawPolyline(ctx, [[point.x, point.y], [next.x, next.y]], '#ded5c5', 0.8);
      }
      drawDisc(ctx, [point.x, point.y], Math.max(1.5, Math.min(3, layout.scale * 0.075)), '#a69c8c');
    }
  }
  const points = layout.points.map((point) => [point.x, point.y]);
  if (points.length > 1) drawPolyline(ctx, points, '#244d3d', Math.max(1.5, layout.scale * 0.06));
  if (layout.closed && points.length > 2) drawPolyline(ctx, [points[points.length - 1], points[0]], '#244d3d', Math.max(1.5, layout.scale * 0.06));
  for (const point of layout.points) {
    drawDisc(ctx, [point.x, point.y], Math.max(3, layout.scale * 0.12), point.index === selectedIndex ? '#cda04d' : '#fffdf7', '#244d3d');
  }
  if (Array.isArray(previewCoordinate) && previewCoordinate.length === 2 && previewCoordinate.every(Number.isFinite)) {
    const [rawX, rawY] = axialPoint(previewCoordinate);
    const first = layout.points[0];
    if (first) {
      // Draft layout is affine, so recover the scale/offset from any rendered point.
      const [sourceX, sourceY] = axialPoint(first.coordinate);
      const x = first.x + (rawX - sourceX) * layout.scale;
      const y = first.y + (rawY - sourceY) * layout.scale;
      drawRing(ctx, [x, y], Math.max(5, layout.scale * 0.18), '#6f974b');
    }
  }
  return layout;
}
