import { DEFAULT_DISPLAY, PLAYER_COLORS, PLAYER_CONTRAST_COLORS } from './display.js';
import { getBoardPositions, getBoardVertices, isBoardPoint, resolveBoardShape, resolveInitialPositions, PLAYER_ORDER } from './core.js';
export const COLORS = PLAYER_COLORS;
const CONTRAST_COLORS = PLAYER_CONTRAST_COLORS, SQRT3_OVER_2 = Math.sqrt(3) / 2;
const NODE_PLAYERS = Object.fromEntries(PLAYER_ORDER.map((player, index) => [2 * index + 1, player]));
const normalized = ([x, y]) => [x + y / 2, y * SQRT3_OVER_2];
function boardBounds(size, playerCount, boardShape) {
  const vertices = getBoardVertices(size, playerCount, boardShape).map(normalized);
  const xs = vertices.map(p => p[0]), ys = vertices.map(p => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

export function boardLayout(size, rect, playerCount = 2, boardShape) {
  boardShape = resolveBoardShape(playerCount, boardShape);
  const bounds = boardBounds(size, playerCount, boardShape), verticalSign = boardShape === 'hexagon' ? 1 : -1;
  const spacing = Math.min(rect.width / (bounds.maxX - bounds.minX), rect.height / (bounds.maxY - bounds.minY));
  const width = spacing * (bounds.maxX - bounds.minX), height = spacing * (bounds.maxY - bounds.minY);
  return { size, playerCount, boardShape, verticalSign, spacing, width, height,
    left: rect.x + (rect.width - width) / 2 - bounds.minX * spacing,
    bottom: boardShape === 'hexagon' ? rect.y + (rect.height - height) / 2 - bounds.minY * spacing : rect.y + height };
}
export function toScreen([x, y], layout) {
  return [layout.left + (x + y / 2) * layout.spacing, layout.bottom + (layout.verticalSign || -1) * y * layout.spacing * SQRT3_OVER_2];
}
export function pointAtScreen(x, y, layout) {
  const py = (y - layout.bottom) / ((layout.verticalSign || -1) * layout.spacing * SQRT3_OVER_2);
  return [(x - layout.left) / layout.spacing - py / 2, py];
}
function clampFocus([x, y], size, playerCount = 2, boardShape) {
  if (resolveBoardShape(playerCount, boardShape) === 'triangle') {
    x = Math.max(0, x); y = Math.max(0, y);
    const scale = x + y > size - 1 ? (size - 1) / (x + y) : 1;
    return [x * scale, y * scale];
  }
  const r = size - 1;
  if (x >= 0 && y >= 0 && x <= 2 * r && y <= 2 * r && x + y >= r && x + y <= 3 * r) return [x, y];
  // Project onto the nearest physical hexagon edge, including fractional drag positions.
  const p = normalized([x, y]), vertices = getBoardVertices(size, playerCount, boardShape).map(normalized);
  let nearest, distance = Infinity;
  vertices.forEach((a, index) => {
    const b = vertices[(index + 1) % vertices.length], dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    const q = [a[0] + t * dx, a[1] + t * dy], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < distance) { nearest = q; distance = d; }
  });
  const py = nearest[1] / SQRT3_OVER_2; return [nearest[0] - py / 2, py];
}
export function focusBoardLayout(size, rect, focus, spacing = 44, playerCount = 2, boardShape) {
  boardShape = resolveBoardShape(playerCount, boardShape);
  const [x, y] = clampFocus(focus, size, playerCount, boardShape), bounds = boardBounds(size, playerCount, boardShape), verticalSign = boardShape === 'hexagon' ? 1 : -1;
  return { size, playerCount, boardShape, verticalSign, spacing, width: spacing * (bounds.maxX - bounds.minX), height: spacing * (bounds.maxY - bounds.minY), focus: [x, y],
    left: rect.x + rect.width / 2 - (x + y / 2) * spacing,
    bottom: rect.y + rect.height / 2 - verticalSign * y * spacing * SQRT3_OVER_2 };
}
export function panBoardFocus(focus, dx, dy, layout) {
  const [x, y] = toScreen(focus, layout);
  return clampFocus(pointAtScreen(x - dx, y - dy, layout), layout.size, layout.playerCount, layout.boardShape);
}
export function hitPoint(x, y, layout) {
  let closest = null, distance = Math.min(24, layout.spacing * 0.49);
  const geometry = screenGeometry(layout);
  for (const [px, py] of geometry.points) {
    const p = geometry.pointRows[py][px], d = Math.hypot(p[0] - x, p[1] - y);
    if (d < distance) { distance = d; closest = [px, py]; }
  }
  return closest;
}

// Cache immutable lattice geometry and its projection; turns change the pieces,
// not the hundreds of static grid segments. Bound zoom/drag caches on mobile.
const latticeCache = new Map(), projectionCache = new Map();
function screenGeometry(layout) {
  const shape = resolveBoardShape(layout.playerCount, layout.boardShape), key = `${layout.size}:${shape}`;
  let lattice = latticeCache.get(key);
  if (!lattice) {
    const points = getBoardPositions(layout.size, layout.playerCount, shape), edges = [];
    for (const p of points) for (const q of [[p[0] + 1, p[1]], [p[0], p[1] + 1], [p[0] + 1, p[1] - 1]]) {
      if (isBoardPoint(q, layout.size, layout.playerCount, shape)) edges.push([p, q]);
    }
    lattice = { points, edges, vertices: getBoardVertices(layout.size, layout.playerCount, shape) };
    if (latticeCache.size >= 24) latticeCache.delete(latticeCache.keys().next().value);
    latticeCache.set(key, lattice);
  }
  const projectionKey = `${key}:${layout.left}:${layout.bottom}:${layout.spacing}:${layout.verticalSign}`;
  if (!projectionCache.has(projectionKey)) {
    if (projectionCache.size >= 4) projectionCache.delete(projectionCache.keys().next().value);
    const pointRows = [];
    for (const p of lattice.points) (pointRows[p[1]] ||= [])[p[0]] = toScreen(p, layout);
    projectionCache.set(projectionKey, { points: lattice.points,
      edges: lattice.edges.map(edge => edge.map(p => toScreen(p, layout))),
      vertices: lattice.vertices.map(p => toScreen(p, layout)), pointRows, gameEdges: new Map() });
  }
  return projectionCache.get(projectionKey);
}

function projectedEdge(edge, geometry, layout) {
  let points = geometry.gameEdges.get(edge);
  if (!points) {
    // Cache only immutable edge strings. Live snapshots and their polygons,
    // nodes and legal points are always read again, even at the same revision.
    points = edge.split('|').map(value => toScreen(value.split(',').map(Number), layout));
    // Bound memory while replaying long games or dragging a zoomed board.
    if (geometry.gameEdges.size >= 2048) geometry.gameEdges.delete(geometry.gameEdges.keys().next().value);
    geometry.gameEdges.set(edge, points);
  }
  return points;
}

function stroke(ctx, points, color, width = 1) {
  ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = width;
  points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
}
function circle(ctx, point, radius, color, outline = null) {
  ctx.beginPath(); ctx.arc(point[0], point[1], radius, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  if (outline) { ctx.strokeStyle = outline; ctx.lineWidth = 2; ctx.stroke(); }
}

function drawStartingPoints(ctx, snapshot, layout) {
  // Roots are part of the saved position, not the current pieces. Reading them
  // on every draw keeps random/custom games, replay and setup previews aligned.
  const starts = snapshot.initialPositions || resolveInitialPositions(layout.size, snapshot.players.length, undefined, layout.boardShape);
  const radius = Math.min(10.5, layout.spacing * 0.36);
  const halo = Math.min(layout.spacing * 0.48, radius + 2);
  ctx.save();
  ctx.font = `bold ${Math.max(5, radius * 1.65)}px sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const player of snapshot.players) {
    const start = starts[player];
    if (!Array.isArray(start) || !isBoardPoint(start, layout.size, snapshot.players.length, layout.boardShape)) continue;
    const p = toScreen(start, layout);
    // A light separator remains visible over territories and edges; a dark
    // numbered core identifies the seat without depending on its hue. Keep the
    // complete badge within half a lattice cell so adjacent roots stay distinct.
    circle(ctx, p, halo, '#fffdf7');
    circle(ctx, p, radius, CONTRAST_COLORS[player]);
    ctx.strokeStyle = '#173d31'; ctx.lineWidth = Math.min(1.2, layout.spacing * 0.06); ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.fillText(String(PLAYER_ORDER.indexOf(player) + 1), p[0], p[1]);
  }
  ctx.restore();
}

export function drawBoard(ctx, snapshot, layout, { selected, hint, target, blocked, lastMove, effects, display = DEFAULT_DISPLAY } = {}) {
  const colors = display.highContrast ? CONTRAST_COLORS : COLORS;
  const geometry = screenGeometry(layout), corners = geometry.vertices;
  const point = p => toScreen(p, layout);
  ctx.beginPath(); corners.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.closePath(); ctx.fillStyle = '#fffaf1'; ctx.fill();
  ctx.beginPath(); ctx.strokeStyle = '#dfd1bb'; ctx.lineWidth = 1;
  for (const [a, b] of geometry.edges) { ctx.moveTo(...a); ctx.lineTo(...b); }
  ctx.stroke();
  for (const player of snapshot.players) {
    const polygon = snapshot.territories[player]?.polygon;
    if (display.territories && polygon?.length > 2) {
      ctx.beginPath(); polygon.map(point).forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      ctx.closePath(); ctx.fillStyle = `${colors[player]}25`; ctx.fill();
    }
    for (const edge of snapshot.edges[player] || []) {
      stroke(ctx, projectedEdge(edge, geometry, layout), colors[player], Math.max(display.highContrast ? 3 : 2, layout.spacing * 0.06));
    }
  }
  if (display.legalMoves && !snapshot.gameOver) for (const move of snapshot.legalMoves) circle(ctx, point(move.point),
    Math.max(0.8, Math.min(display.highContrast ? 3.2 : 2.4, layout.spacing * 0.16)), display.highContrast ? '#527a5f' : '#8ab397');
  if (effects) {
    ctx.save();
    for (const player of snapshot.players) for (const edge of effects.addedEdgesByPlayer[player] || []) {
      const endpoints = projectedEdge(edge, geometry, layout);
      stroke(ctx, endpoints, '#fffdf7', 6);
      ctx.setLineDash([5, 4]); stroke(ctx, endpoints, colors[player], 3); ctx.setLineDash([]);
    }
    for (const captured of effects.capturedPoints) {
      const [x, y] = point(captured), r = 5;
      circle(ctx, [x, y], 7, '#fffdf7');
      stroke(ctx, [[x - r, y - r], [x + r, y + r]], '#b7382e', 2);
      stroke(ctx, [[x + r, y - r], [x - r, y + r]], '#b7382e', 2);
    }
    ctx.restore();
  }
  snapshot.boardMatrix.forEach((row, y) => row.forEach((state, x) => {
    const player = NODE_PLAYERS[state];
    if (player) {
      const p = point([x, y]), r = Math.max(layout.boardShape === 'hexagon' ? 2 : 4.5, Math.min(8, layout.spacing * 0.18));
      circle(ctx, p, r, colors[player], '#fffdf7');
      if (display.highContrast && r >= 4.5) {
        if (player === 'BLACK') circle(ctx, p, 2, '#fffdf7');
        if (player === 'WHITE') stroke(ctx, [[p[0] - 3, p[1]], [p[0] + 3, p[1]]], '#fffdf7', 2);
        if (player === 'PURPLE') stroke(ctx, [[p[0] - 3, p[1] + 2], [p[0], p[1] - 3], [p[0] + 3, p[1] + 2], [p[0] - 3, p[1] + 2]], '#fffdf7', 1.5);
        if (player === 'GREEN') { stroke(ctx, [[p[0] - 3, p[1]], [p[0] + 3, p[1]]], '#fffdf7', 1.5); stroke(ctx, [[p[0], p[1] - 3], [p[0], p[1] + 3]], '#fffdf7', 1.5); }
        if (player === 'ORANGE') stroke(ctx, [[p[0] - 2, p[1] - 2], [p[0] + 2, p[1] - 2], [p[0] + 2, p[1] + 2], [p[0] - 2, p[1] + 2], [p[0] - 2, p[1] - 2]], '#fffdf7', 1.5);
        if (player === 'CYAN') { stroke(ctx, [[p[0] - 2, p[1] - 2], [p[0] + 2, p[1] + 2]], '#fffdf7', 1.5); stroke(ctx, [[p[0] + 2, p[1] - 2], [p[0] - 2, p[1] + 2]], '#fffdf7', 1.5); }
      }
    }
  }));
  drawStartingPoints(ctx, snapshot, layout);
  if (display.coordinates && layout.spacing >= 38) {
    ctx.save(); ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#526759';
    for (const [x, y] of geometry.points) {
      const p = point([x, y]); ctx.fillText(`${x},${y}`, p[0], p[1] + 14);
    }
    ctx.restore();
  }
  if (display.lastMove && lastMove) {
    const [x, y] = point(lastMove), r = Math.max(2, Math.min(4, layout.spacing * 0.1));
    ctx.fillStyle = '#fffef9'; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.strokeStyle = '#244d3d'; ctx.lineWidth = 1; ctx.strokeRect(x - r, y - r, r * 2, r * 2);
  }
  for (const [p, color] of [[hint, '#6f974b'], [target, '#cda04d'], [selected, '#244d3d']]) {
    if (!p) continue;
    const [x, y] = point(p), radius = Math.max(8, Math.min(16, layout.spacing * 0.34));
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.lineWidth = 2.5; ctx.strokeStyle = color; ctx.stroke();
  }
  if (blocked) {
    const [x, y] = point(blocked), r = 5;
    stroke(ctx, [[x - r, y - r], [x + r, y + r]], '#ca5a4e', 2);
    stroke(ctx, [[x + r, y - r], [x - r, y + r]], '#ca5a4e', 2);
  }
}
