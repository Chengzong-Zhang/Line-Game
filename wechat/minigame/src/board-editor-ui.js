import { PLAYER_COLORS } from './display.js';
import { topologyStartingRoots } from './topology/TopologyStartingPoints.js';

const SQRT3_OVER_2 = Math.sqrt(3) / 2;
const plane = c => [c[0] + c[1] * 0.5, c[1] * SQRT3_OVER_2];
const distanceToSegment = (x, y, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length)) : 0;
  return Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
};

/** All input and rendering use the same layout; rule IDs come from the compiler. */
export function layoutBoardEditor(setup, rect, options = {}) {
  if (!rect || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(rect[k])) || rect.width <= 0 || rect.height <= 0)
    throw new TypeError('Expected a positive editor rectangle.');
  const size = Math.max(2, Math.min(31, Number.isInteger(options.gridSize) ? options.gridSize : 9));
  const draft = setup?.draft, definition = setup?.definition, board = setup?.compiled;
  const rings = draft?.rings ?? [];
  const grid = [];
  for (let q = 0; q < size; q++) for (let r = 0; r < size; r++) grid.push([q, r]);
  const gridKeys = new Set(grid.map(c => c.join(',')));
  for (const coordinate of [...(definition?.vertices ?? []).map(v => v.coordinate), ...rings.flat()]) {
    if (!gridKeys.has(coordinate.join(','))) { grid.push([...coordinate]); gridKeys.add(coordinate.join(',')); }
  }
  const coordinates = [...grid, ...rings.flat(), ...(draft?.path ?? []), ...(definition?.vertices ?? []).map(v => v.coordinate)];
  const xs = coordinates.map(c => plane(c)[0]), ys = coordinates.map(c => plane(c)[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const padding = Math.max(0, Math.min(options.padding ?? 18, rect.width / 2, rect.height / 2));
  const baseScale = Math.min(Math.max(1, rect.width - 2 * padding) / Math.max(1, maxX - minX),
    Math.max(1, rect.height - 2 * padding) / Math.max(1, maxY - minY));
  const zoom = Number.isFinite(options.zoom) ? Math.max(1, Math.min(4, options.zoom)) : 1;
  const pan = { x: Number.isFinite(options.pan?.x) ? options.pan.x : 0,
    y: Number.isFinite(options.pan?.y) ? options.pan.y : 0 };
  const scale = baseScale * zoom;
  const center = [rect.x + rect.width / 2, rect.y + rect.height / 2];
  const baseOffset = [rect.x + (rect.width - (maxX - minX) * baseScale) / 2 - minX * baseScale,
    rect.y + (rect.height - (maxY - minY) * baseScale) / 2 - minY * baseScale];
  const offset = zoom === 1 ? [baseOffset[0] + pan.x, baseOffset[1] + pan.y]
    : [center[0] + (baseOffset[0] - center[0]) * zoom + pan.x,
      center[1] + (baseOffset[1] - center[1]) * zoom + pan.y];
  const project = coordinate => { const p = plane(coordinate); return { x: p[0] * scale + offset[0], y: p[1] * scale + offset[1] }; };
  const gridPoints = grid.map(coordinate => ({ coordinate, ...project(coordinate) }));
  const contourPoints = rings.map(ring => ring.map(project));
  const path = (draft?.closed ? [] : draft?.path ?? []).map(project);
  const vertices = new Map((definition?.vertices ?? []).map(v => [v.id, v.coordinate]));
  const faces = new Map((definition?.faces ?? []).map(f => [f.id, f]));
  const edge = id => {
    const split = id.lastIndexOf(':'), face = faces.get(id.slice(0, split)), side = Number(id.slice(split + 1));
    if (!face || !Number.isInteger(side) || side < 0 || side > 2) return null;
    const a = vertices.get(face.vertices[side]), b = vertices.get(face.vertices[(side + 1) % 3]);
    return a && b ? { id, a: project(a), b: project(b) } : null;
  };
  const edges = (draft?.boundaryOccurrenceIds ?? []).map(edge).filter(Boolean);
  const seams = (definition?.seamPairs ?? []).map(pair => ({ id: pair.id, endpointMap: pair.endpointMap,
    edges: [edge(pair.edgeOccurrenceA), edge(pair.edgeOccurrenceB)].filter(Boolean) }));
  const roots = topologyStartingRoots(board ?? {}), rootOwners = new Map();
  for (const [player, ids] of Object.entries(roots)) for (const id of ids) rootOwners.set(id, player);
  const points = (board?.atlas?.pointCopies ?? []).map(copy => ({ vertexId: copy.canonicalVertexId,
    coordinate: [...copy.coordinate], owner: rootOwners.get(copy.canonicalVertexId) ?? null, ...project(copy.coordinate) }));
  return { rect: { ...rect }, scale, gridPoints, contourPoints, path, edges, seams, points,
    hitRadius: Math.max(8, Math.min(22, scale * 0.42)), selectedEdges: setup?.selectedBoundaryOccurrenceIds ?? [],
    selectedRing: options.selectedRing ?? null };
}

/** mode is 'contour', 'seam', 'root', or 'select-ring'. */
export function hitTestBoardEditor(layout, x, y, mode = 'contour') {
  if (!layout || !Number.isFinite(x) || !Number.isFinite(y) || x < layout.rect.x || y < layout.rect.y
    || x > layout.rect.x + layout.rect.width || y > layout.rect.y + layout.rect.height) return null;
  const nearPoint = list => list.map(point => ({ point, distance: Math.hypot(point.x - x, point.y - y) }))
    .filter(entry => entry.distance <= layout.hitRadius).sort((a, b) => a.distance - b.distance)[0]?.point;
  if (mode === 'root') { const p = nearPoint(layout.points); return p ? { type: 'vertex', vertexId: p.vertexId, coordinate: p.coordinate, owner: p.owner } : null; }
  if (mode === 'seam') {
    const candidates = [...layout.edges.map(e => ({ ...e, type: 'edge' })),
      ...layout.seams.flatMap(s => s.edges.map(e => ({ ...e, type: 'seam', seamId: s.id })))];
    const best = candidates.map(e => ({ e, d: distanceToSegment(x, y, e.a, e.b) }))
      .filter(e => e.d <= layout.hitRadius).sort((a, b) => a.d - b.d)[0]?.e;
    return best ? best.type === 'seam' ? { type: 'seam', seamId: best.seamId } : { type: 'edge', occurrenceId: best.id } : null;
  }
  if (mode === 'select-ring') {
    let best = null;
    layout.contourPoints.forEach((ring, index) => ring.forEach((a, i) => {
      const d = distanceToSegment(x, y, a, ring[(i + 1) % ring.length]);
      if (d <= layout.hitRadius && (!best || d < best.d)) best = { index, d };
    }));
    return best ? { type: 'ring', index: best.index } : null;
  }
  const p = nearPoint(layout.gridPoints); return p ? { type: 'coordinate', coordinate: [...p.coordinate] } : null;
}

export function renderBoardEditor(ctx, rect, setup, options = {}) {
  const layout = layoutBoardEditor(setup, rect, options);
  const line = (points, color, width, close = false) => {
    if (points.length < 2) return;
    ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
    for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
    if (close) ctx.closePath(); ctx.lineWidth = width; ctx.strokeStyle = color; ctx.stroke();
  };
  const dot = (p, color, radius) => { ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); };
  const canClip = ['save', 'restore', 'rect', 'clip'].every(name => typeof ctx[name] === 'function');
  if (canClip) ctx.save();
  try {
    if (canClip) { ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.width, rect.height); ctx.clip(); }
    for (const p of layout.gridPoints) dot(p, '#b6ac99', Math.max(1, Math.min(2.5, layout.scale * 0.06)));
    layout.contourPoints.forEach((ring, index) => line(ring, index === layout.selectedRing ? '#c58c32' : '#315843', 2, true));
    line(layout.path, '#315843', 2);
    for (const [index, seam] of layout.seams.entries()) {
      for (const [side, e] of seam.edges.entries()) {
        line([e.a, e.b], '#a156ab', 4);
        // Matching endpoint colours show whether the two sides are reversed.
        const colors = side === 0 || seam.endpointMap?.[0] === 0 ? ['#d58a23', '#397fbe'] : ['#397fbe', '#d58a23'];
        dot(e.a, colors[0], 3); dot(e.b, colors[1], 3);
        if (typeof ctx.fillText === 'function') {
          ctx.fillStyle = '#693b78'; ctx.font = '12px sans-serif';
          ctx.fillText(String(index + 1), (e.a.x + e.b.x) / 2 + 3, (e.a.y + e.b.y) / 2 - 3);
        }
      }
    }
    for (const e of layout.edges) if (layout.selectedEdges.includes(e.id)) line([e.a, e.b], '#cf8b26', 4);
    for (const p of layout.points) if (p.owner) dot(p, PLAYER_COLORS[p.owner] ?? '#315843', Math.max(4, Math.min(8, layout.scale * 0.18)));
  } finally { if (canClip) ctx.restore(); }
  return layout;
}
