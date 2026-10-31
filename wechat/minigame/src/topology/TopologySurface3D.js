import { createSurfacePreset } from "./BoardPresets.js?v=20261029-topology-round5";
import { projectPath } from "./BoardView.js?v=20261029-topology-round5";
import { buildTopologyTerritoryDisplay, pointInDisplayPolygon } from "./TerritoryDisplay.js?v=20261029-topology-round5";
import { createDoubleTorusBoardDefinition, createDoubleSphereBoardDefinition } from "./RandomSurfaceBoard.js?v=20261029-topology-round5";

// Node and line colors match Renderer.js. Surface colors use the same hues
// at higher opacity so curved front faces visibly occlude the back of a board.
export const DEFAULT_SURFACE_PALETTE = Object.freeze({
  BLACK: { node: "#2b6fff", line: "#1f4fba", surface: "#85aaf1" },
  WHITE: { node: "#e44b4b", line: "#a83434", surface: "#ed9595" },
  PURPLE: { node: "#8b5cf6", line: "#6d28d9", surface: "#b49aeb" },
  GREEN: { node: "#22965a", line: "#166b3d", surface: "#83c49f" },
  ORANGE: { node: "#e79824", line: "#a8620d", surface: "#ecc07f" },
  CYAN: { node: "#16a6b6", line: "#087785", surface: "#83cbd0" },
});
export const NEUTRAL_SURFACE_COLOR = "#ded3bf";
const SUPPORTED = new Set(["cylinder", "torus", "mobius", "tetrahedron", "cone", "sphere"]);
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

export function resolveSurfaceSamplePlayer(matches) {
  const owners = new Set(matches.map(match => match.player));
  return owners.size === 1 ? owners.values().next().value : null;
}

// Two-sided lighting is necessary for the Möbius strip. The result is a
// bounded translucent shadow drawn on top of an opaque face.
export function surfaceShadow(points) {
  if (!Array.isArray(points) || points.length < 4) return 0;
  const a = points[1].map((v, i) => v - points[0][i]);
  const b = points[3].map((v, i) => v - points[0][i]);
  const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const length = Math.hypot(...n);
  if (!Number.isFinite(length) || length < 1e-10) return 0;
  const light = [-0.4, 0.6, 0.7], lightLength = Math.hypot(...light);
  const cosine = Math.min(1, Math.abs(n.reduce((sum, value, i) => sum + value * light[i], 0) / (length * lightLength)));
  return 0.03 + 0.30 * (1 - cosine);
}

export function initialSurfacePitch(definition) {
  return identifySurface(definition).kind === "torus" ? 0.8 : -0.3;
}

// A preset name alone is not proof of an embedding. Compare the complete
// patch and seam identification with the actual preset before wrapping it.
export function identifySurface(definition) {
  const preset = definition?.topology?.preset;
  const vertices = definition?.vertices ?? [];
  if (preset === 'double-torus' || preset === 'double-sphere') {
    const n = definition?.generator?.options?.gridSize;
    try {
      if (!Number.isInteger(n) || n < 5 || n > 15) return { kind: 'atlas' };
      const expected = preset === 'double-torus'
        ? createDoubleTorusBoardDefinition({ gridSize: n, holeFaces: definition?.generator?.holeFaces, trimFaces: definition?.generator?.trimFaces })
        : createDoubleSphereBoardDefinition({ gridSize: n });
      const normalize = d => JSON.stringify({ vertices: d.vertices.map(v => [v.id, v.coordinate]).sort(), faces: d.faces.map(f => [f.id, f.vertices]).sort(), seams: d.seamPairs.map(s => [s.id, s.edgeOccurrenceA, s.edgeOccurrenceB, s.endpointMap]).sort() });
      if (normalize(expected) === normalize(definition)) return makeDoubleSurface(expected, n, preset);
    } catch { /* Unverified geometry remains an atlas. */ }
    return { kind: 'atlas' };
  }
  if (!SUPPORTED.has(preset) || !vertices.length) return { kind: "atlas" };
  const xs = vertices.map((v) => v.coordinate?.[0]);
  const ys = vertices.map((v) => v.coordinate?.[1]);
  const width = Math.max(...xs), height = Math.max(...ys);
  if (Math.min(...xs) !== 0 || Math.min(...ys) !== 0 || !Number.isInteger(width) || !Number.isInteger(height)) return { kind: "atlas" };
  try {
    if ((preset === "tetrahedron" || preset === "sphere") && (width !== height || width % 2 !== 0)) return { kind: "atlas" };
    if (preset === "cone" && (width !== 2 * height || width % 2 !== 0)) return { kind: "atlas" };
    const expected = ["tetrahedron", "sphere", "cone"].includes(preset)
      ? createSurfacePreset(preset, { gridSize: width + 1 })
      : createSurfacePreset(preset, { width, height });
    const normalized = (d) => JSON.stringify({
      vertices: d.vertices.map((v) => [v.id, v.coordinate]).sort((a, b) => a[0].localeCompare(b[0])),
      faces: d.faces.map((f) => [f.id, f.vertices]).sort((a, b) => a[0].localeCompare(b[0])),
      seams: d.seamPairs.map((s) => [s.id, s.edgeOccurrenceA, s.edgeOccurrenceB, s.endpointMap]).sort((a, b) => a[0].localeCompare(b[0])),
    });
    return normalized(expected) === normalized(definition) ? { kind: preset, width, height } : { kind: "atlas" };
  } catch { return { kind: "atlas" }; }
}

const plane = ([x, y]) => [x + y / 2, y * Math.sqrt(3) / 2];
const segmentDistance = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

function makeDoubleSurface(definition, gridSize, kind) {
  const raw = new Map(definition.vertices.map(v => [v.id, v.coordinate]));
  const frontFaces = definition.faces.filter(f => !f.id.startsWith('back:'));
  const edges = new Map();
  for (const face of frontFaces) for (let i = 0; i < 3; i++) {
    const ids = [face.vertices[i], face.vertices[(i + 1) % 3]], key = [...ids].sort().join('|');
    const list = edges.get(key) ?? []; list.push(ids); edges.set(key, list);
  }
  const boundary = [...edges.values()].filter(e => e.length === 1).map(([ids]) => ids.map(id => plane(raw.get(id))));
  const height = p => Math.min(...boundary.map(([a, b]) => segmentDistance(plane(p), a, b))) * 0.7;
  const faces = new Map();
  for (const face of definition.faces) {
    const back = face.id.startsWith('back:'), offset = back ? gridSize + 1 : 0;
    const points = face.vertices.map(id => { const p = raw.get(id); return [p[0] - offset, p[1]]; });
    const center = [0, 1].map(axis => points.reduce((s, p) => s + p[axis], 0) / 3);
    const pieces = [];
    for (let i = 0; i < 3; i++) {
      const p = points[i], next = points[(i + 1) % 3], mid = lerp(p, next, 0.5);
      pieces.push([p, mid, center]); pieces.push([next, center, mid]);
    }
    faces.set(face.id, { back, offset, pieces: pieces.map(triangle => ({ points: triangle, heights: triangle.map(height) })) });
  }
  return { kind, gridSize, faces };
}

function doublePosition(surface, coordinate, faceId) {
  const face = surface.faces.get(faceId);
  if (!face) return null;
  const p = [coordinate[0] - face.offset, coordinate[1]];
  for (const piece of face.pieces) {
    const [a, b, c] = piece.points, det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    const u = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / det;
    const v = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / det, w = 1 - u - v;
    if (Math.min(u, v, w) >= -1e-8) {
      const [x, y] = plane(p), scale = 2 / (1.5 * (surface.gridSize - 1));
      return [(x - 0.75 * (surface.gridSize - 1)) * scale, (y - Math.sqrt(3) / 4 * (surface.gridSize - 1)) * scale, (face.back ? -1 : 1) * (u * piece.heights[0] + v * piece.heights[1] + w * piece.heights[2]) * scale];
    }
  }
  return null;
}

export function surfacePosition(surface, coordinate, bounds, faceId = null) {
  const [x, y] = coordinate;
  if (surface.kind === 'double-torus' || surface.kind === 'double-sphere') {
    if (faceId) return doublePosition(surface, coordinate, faceId);
    for (const id of surface.faces.keys()) { const p = doublePosition(surface, coordinate, id); if (p) return p; }
    return null;
  }
  if (surface.kind === "atlas") {
    const dx = bounds.maxX - bounds.minX || 1, dy = bounds.maxY - bounds.minY || 1;
    return [2 * (x - bounds.minX) / dx - 1 + (y - bounds.minY) / dy * 0.4, 1 - 2 * (y - bounds.minY) / dy, 0];
  }
  if (surface.kind === "cone") {
    const r = surface.width / 2, a = x - r;
    const radial = Math.max(Math.abs(a), Math.abs(y), Math.abs(a + y)) / r;
    if (radial < 1e-12) return [0, 1, 0];
    const angle = 2 * Math.atan2(Math.sqrt(3) * y / 2, a + y / 2);
    return [radial * Math.cos(angle), 1 - 2 * radial, radial * Math.sin(angle)];
  }
  if (surface.kind === "tetrahedron" || surface.kind === "sphere") {
    // The net consists of four equal triangular patches with corners at
    // (0,0), (m,0), (0,m), (m,m), (2m,0), (0,2m). The three outer
    // corners represent the same tetrahedron vertex. Each branch evaluates
    // the corresponding face's barycentric coordinates; shared edges agree.
    const m = surface.width / 2, k = 1 / Math.sqrt(3);
    const A = [k, -k, -k], B = [-k, k, -k], C = [-k, -k, k], D = [k, k, k];
    let weights;
    if (x + y <= m) weights = [[D, 1 - (x + y) / m], [A, x / m], [B, y / m]];
    else if (x >= m) weights = [[A, (2 * m - x - y) / m], [D, (x - m) / m], [C, y / m]];
    else if (y >= m) weights = [[B, (2 * m - x - y) / m], [D, (y - m) / m], [C, x / m]];
    else weights = [[A, (m - y) / m], [B, (m - x) / m], [C, (x + y - m) / m]];
    const point = [0, 1, 2].map(axis => weights.reduce((sum, [vertex, weight]) => sum + vertex[axis] * weight, 0));
    if (surface.kind === "sphere") { const length = Math.hypot(...point); return point.map(value => value / length); }
    return point;
  }
  const u = 2 * Math.PI * x / surface.width;
  const v = y / surface.height;
  if (surface.kind === "cylinder") return [Math.cos(u), 1 - 2 * v, Math.sin(u)];
  if (surface.kind === "mobius") {
    const w = (v - 0.5) * 1.1;
    return [(1 + w * Math.cos(u / 2)) * Math.cos(u), w * Math.sin(u / 2), (1 + w * Math.cos(u / 2)) * Math.sin(u)];
  }
  const a = 2 * Math.PI * v, radius = 1 + 0.38 * Math.cos(a);
  return [radius * Math.cos(u), 0.38 * Math.sin(a), radius * Math.sin(u)];
}

// The same display polygons as the atlas are sampled on a tessellated surface.
// Tessellation is a preview approximation; discrete scores remain untouched.
export function buildSurfaceCells(snapshot, subdivisions = 3, lastMoves = {}) {
  const view = snapshot?.topology?.viewBoard;
  const copies = new Map((view?.pointCopies ?? []).map((copy) => [copy.id, copy]));
  const surface = identifySurface(snapshot?.boardDefinition);
  const copyFace = new Map(), edgeFace = new Map();
  for (const face of view?.faces ?? []) {
    for (const id of face.copyIds ?? []) if (!copyFace.has(id)) copyFace.set(id, face.id);
    for (let i = 0; i < (face.copyIds?.length ?? 0); i++) {
      const key = [face.copyIds[i], face.copyIds[(i + 1) % face.copyIds.length]].sort().join('\0');
      if (!edgeFace.has(key)) edgeFace.set(key, face.id);
    }
  }
  const coordinates = [...copies.values()].map((c) => c.coordinate);
  if (!coordinates.length) return { surface, cells: [], nodes: [], lines: [] };
  const bounds = { minX: Math.min(...coordinates.map((p) => p[0])), maxX: Math.max(...coordinates.map((p) => p[0])), minY: Math.min(...coordinates.map((p) => p[1])), maxY: Math.max(...coordinates.map((p) => p[1])) };
  const polygons = snapshot.territoryPending ? [] : buildTopologyTerritoryDisplay(snapshot);
  const cells = [];
  for (const face of view.faces ?? []) {
    const points = (face.copyIds ?? []).map((id) => copies.get(id));
    if (points.length !== 3 || points.some((p) => !p)) continue;
    const coords = points.map((p) => p.coordinate);
    const center = [0, 1].map((axis) => coords.reduce((s, p) => s + p[axis], 0) / 3);
    for (let i = 0; i < 3; i += 1) {
      const p = coords[i], next = coords[(i + 1) % 3], prev = coords[(i + 2) % 3];
      const quad = [p, lerp(p, next, 0.5), center, lerp(p, prev, 0.5)];
      const pointAt = (u, v) => lerp(lerp(quad[0], quad[1], u), lerp(quad[3], quad[2], u), v);
      for (let y = 0; y < subdivisions; y += 1) for (let x = 0; x < subdivisions; x += 1) {
        const a = x / subdivisions, b = y / subdivisions, c = (x + 1) / subdivisions, d = (y + 1) / subdivisions;
        const centerPoint = pointAt((a + c) / 2, (b + d) / 2);
        const matches = polygons.filter((polygon) => (!polygon.faceId || polygon.faceId === face.id)
          && polygon.chartId === (points[i].chartId ?? "chart:0")
          && pointInDisplayPolygon(centerPoint, polygon.polygon));
        const player = resolveSurfaceSamplePlayer(matches);
        cells.push({ player, faceId: face.id, atlasCenter: centerPoint, points: [pointAt(a, b), pointAt(c, b), pointAt(c, d), pointAt(a, d)].map((p) => surfacePosition(surface, p, bounds, face.id)) });
      }
    }
  }
  const roots = snapshot.topology?.startingRoots ?? snapshot.initialRoots
    ?? Object.fromEntries(Object.entries(snapshot.initialPositions ?? {}).map(([player, id]) => [player, [id]]));
  const starts = new Map(Object.entries(roots).flatMap(([player, ids]) =>
    (Array.isArray(ids) ? ids : [ids]).map((id) => [id, player])));
  const players = ["BLACK", "WHITE", "PURPLE", "GREEN", "ORANGE", "CYAN"];
  const nodes = [...copies.values()].filter((copy) => {
    const state = snapshot.boardStates?.[copy.canonicalVertexId];
    return Number.isInteger(state) && state >= 1 && state <= 11 && state % 2 === 1;
  }).map((copy) => {
    const player = players[(snapshot.boardStates[copy.canonicalVertexId] - 1) / 2];
    return { point: surfacePosition(surface, copy.coordinate, bounds, copyFace.get(copy.id)), player,
      canonicalVertexId: copy.canonicalVertexId, start: starts.has(copy.canonicalVertexId),
      latest: snapshot.players?.includes(player) && !(snapshot.resignedPlayers ?? []).includes(player)
        && lastMoves[player] === copy.canonicalVertexId };
  });
  // Subdivide only for curved geometry. Grid lines are the original face
  // edges, not the internal quad boundaries used for ownership coloring.
  const lines = [];
  const appendLine = (copyIds, player = null) => {
    const pair = copyIds.map((id) => copies.get(id));
    if (pair.length !== 2 || pair.some((copy) => !copy)) return;
    const faceId = edgeFace.get([...copyIds].sort().join('\0'));
    const steps = Math.max(4, subdivisions * 2);
    for (let i = 0; i < steps; i += 1) {
      lines.push({ player, points: [i / steps, (i + 1) / steps].map((t) => surfacePosition(surface, lerp(pair[0].coordinate, pair[1].coordinate, t), bounds, faceId)) });
    }
  };
  const seenEdges = new Set();
  for (const face of view.faces ?? []) {
    if (face.copyIds?.length !== 3) continue;
    for (let i = 0; i < 3; i += 1) {
      const pair = [face.copyIds[i], face.copyIds[(i + 1) % 3]];
      const key = [...pair].sort().join("\0");
      if (!seenEdges.has(key)) { seenEdges.add(key); appendLine(pair); }
    }
  }
  for (const [player, paths] of Object.entries(snapshot.topologyPaths ?? {})) {
    if (!Array.isArray(paths)) continue;
    for (const path of paths) {
      for (const segment of projectPath(view, path)) {
        for (let i = 0; i + 1 < segment.copyIds.length; i += 1) appendLine(segment.copyIds.slice(i, i + 2), player);
      }
    }
  }
  return { surface, cells, nodes, lines };
}

export function createDepthRenderer(canvas) {
  let gl;
  try { gl = canvas.getContext('webgl', { antialias: true, depth: true, alpha: false }); } catch { return null; }
  if (!gl || typeof gl.createShader !== 'function') return null;
  const shader = (type, source) => {
    const result = gl.createShader(type); gl.shaderSource(result, source); gl.compileShader(result);
    if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(result));
    return result;
  };
  try {
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, 'attribute vec3 position; uniform float pointSize; void main(){gl_Position=vec4(position,1.0);gl_PointSize=pointSize;}'));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, 'precision mediump float; uniform vec4 color; uniform float pointMode; void main(){if(pointMode>0.5 && distance(gl_PointCoord,vec2(0.5))>0.5) discard; gl_FragColor=color;}'));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const position = gl.getAttribLocation(program, 'position'), color = gl.getUniformLocation(program, 'color'), size = gl.getUniformLocation(program, 'pointSize'), pointMode = gl.getUniformLocation(program, 'pointMode'), buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    const rgba = input => {
      const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(input ?? '');
      if (!match) return [0.6, 0.56, 0.49, 1];
      const hex = match[1].length === 3 ? [...match[1]].map(c => c + c).join('') : match[1];
      return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).concat(1);
    };
    return {
      draw(data, width, height, rotate, zoom, palette, dpr) {
        gl.viewport(0, 0, width, height); gl.clearColor(0.965, 0.945, 0.91, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        const scale = Math.min(width, height) * 0.6 * zoom;
        const transform = (p, lift = 0) => { const q = rotate(p); return [q[0] * scale / width, q[1] * scale / height, -(q[2] + lift) / 4]; };
        const draw = (points, mode, fill, pointSize = 1, shade = 0) => {
          const tint = rgba(fill).map((channel, index) => index === 3 ? channel : channel * (1 - shade));
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(points.flat()), gl.STREAM_DRAW); gl.uniform4fv(color, tint); gl.uniform1f(size, pointSize); gl.uniform1f(pointMode, mode === gl.POINTS ? 1 : 0); gl.drawArrays(mode, 0, points.length);
        };
        const faceGroups = new Map(), lineGroups = new Map(), pointGroups = new Map();
        const append = (groups, key, points) => { const group = groups.get(key) ?? []; group.push(...points); groups.set(key, group); };
        for (const cell of data.cells) {
          if (cell.points.some(p => !p)) continue;
          const p = cell.points.map(v => transform(v));
          const fill = palette[cell.player]?.surface ?? palette[cell.player]?.territory ?? DEFAULT_SURFACE_PALETTE[cell.player]?.surface ?? NEUTRAL_SURFACE_COLOR;
          const shade = Math.round(surfaceShadow(cell.points.map(rotate)) * 12) / 12;
          append(faceGroups, JSON.stringify([fill, shade]), [p[0], p[1], p[2], p[0], p[2], p[3]]);
        }
        for (const [key, points] of faceGroups) { const [fill, shade] = JSON.parse(key); draw(points, gl.TRIANGLES, fill, 1, shade); }
        for (const line of data.lines) {
          if (line.points.some(p => !p)) continue;
          const fill = palette[line.player]?.line ?? DEFAULT_SURFACE_PALETTE[line.player]?.line ?? '#655b4b';
          const key = JSON.stringify([fill, Boolean(line.player)]);
          append(lineGroups, key, line.points.map(p => transform(p, line.player ? 0.004 : 0.002)));
        }
        for (const [key, points] of lineGroups) { const [fill, owned] = JSON.parse(key); gl.lineWidth(owned ? Math.max(2, 2 * dpr) : 1); draw(points, gl.LINES, fill); }
        for (const node of data.nodes) if (node.point && node.latest)
          draw([transform(node.point, 0.006)], gl.POINTS, '#fffdf7', (node.start ? 17 : 13) * dpr);
        for (const node of data.nodes) if (node.point) {
          const key = JSON.stringify([palette[node.player]?.node ?? DEFAULT_SURFACE_PALETTE[node.player]?.node ?? '#3a3125', Boolean(node.start)]);
          append(pointGroups, key, [transform(node.point, 0.006)]);
        }
        for (const [key, points] of pointGroups) { const [fill, start] = JSON.parse(key); draw(points, gl.POINTS, fill, (start ? 12 : 8) * dpr); }
      },
      destroy() { gl.deleteBuffer(buffer); gl.deleteProgram(program); },
    };
  } catch { return null; }
}

/** Mount a self-contained, disposable surface viewer. Call update for new snapshots. */
export function mountTopologySurface3D(container, snapshot, options = {}) {
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "width:100%;max-width:620px;margin:auto;color:inherit;text-align:center";
  const label = document.createElement("p");
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;width:100%;height:clamp(220px,48vw,380px);touch-action:none;border-radius:12px;background:#f6f1e8";
  canvas.tabIndex = 0;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "action-button action-button-secondary";
  button.style.cssText = "margin:8px;padding:8px 14px;min-height:40px";
  const zoomOut = document.createElement("button"), zoomIn = document.createElement("button");
  zoomOut.type = zoomIn.type = "button";
  zoomOut.className = zoomIn.className = "action-button action-button-secondary";
  zoomOut.style.cssText = zoomIn.style.cssText = "margin:8px;padding:8px 14px;min-height:40px";
  wrapper.append(label, canvas, zoomOut, button, zoomIn);
  container.append(wrapper);
  const depthRenderer = createDepthRenderer(canvas);
  const ctx = depthRenderer ? null : canvas.getContext("2d");
  const motion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  let language = String(options.language ?? "zh").toLowerCase().startsWith("en") ? "en" : "zh";
  let palette = options.palette ?? {};
  let paused = Boolean(motion?.matches), data, yaw = 0.45, pitch = initialSurfacePitch(snapshot?.boardDefinition), zoom = 1, frame = 0, drag = null, destroyed = false;
  const updateButton = () => { button.textContent = language === "en" ? (paused ? "Start rotation" : "Pause rotation") : (paused ? "开始自动旋转" : "暂停自动旋转"); };
  const updateLabels = () => {
    const english = language === "en";
    canvas.setAttribute("aria-label", english ? "Rotatable topology board. Drag or use arrow keys to rotate; use the wheel or buttons to zoom." : "可旋转拓扑棋盘，拖动或方向键旋转，滚轮或加减按钮缩放");
    zoomOut.textContent = english ? "Zoom out −" : "缩小 −";
    zoomIn.textContent = english ? "Zoom in +" : "放大 +";
    label.textContent = data.surface.kind === "atlas"
      ? (english ? "Unfolded face map (no verified 3D surface for this board; a Klein bottle immersion in 3D self-intersects)" : "展开面片图（此棋盘没有可确认的三维曲面模型；克莱因瓶的三维浸入会自交）")
      : (english ? ({ cylinder: "Cylinder", torus: "Torus", mobius: "Möbius strip", tetrahedron: "Tetrahedron", cone: "Cone", sphere: "Sphere", 'double-torus': 'Double torus', 'double-sphere': 'Sphere' })[data.surface.kind] + " · Drag to rotate; use the wheel to zoom" : ({ cylinder: "圆柱", torus: "环面", mobius: "莫比乌斯带", tetrahedron: "三角锥", cone: "圆锥", sphere: "球面", 'double-torus': '双环面', 'double-sphere': '球面' })[data.surface.kind] + " · 拖动旋转，滚轮缩放");
    if (!depthRenderer) label.textContent += english ? ' · Depth buffer unavailable; preview uses approximate ordering' : ' · 深度缓冲不可用，预览采用近似遮挡';
    updateButton();
  };
  const rotate = ([x, y, z]) => {
    const a = x * Math.cos(yaw) - z * Math.sin(yaw), b = x * Math.sin(yaw) + z * Math.cos(yaw);
    return [a, y * Math.cos(pitch) - b * Math.sin(pitch), y * Math.sin(pitch) + b * Math.cos(pitch)];
  };
  const draw = () => {
    if (destroyed || (!ctx && !depthRenderer) || !data) return;
    const rect = canvas.getBoundingClientRect(), dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * dpr)), height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    if (depthRenderer) { depthRenderer.draw(data, width, height, rotate, zoom, palette, dpr); return; }
    ctx.clearRect(0, 0, width, height);
    const scale = Math.min(width, height) * 0.30 * zoom;
    const project = (p) => [width / 2 + p[0] * scale, height / 2 - p[1] * scale];
    const items = data.cells.map((cell) => {
      const rotated = cell.points.map(rotate);
      return { ...cell, rotated, depth: rotated.reduce((s, p) => s + p[2], 0) / rotated.length };
    });
    for (const line of data.lines) {
      const rotated = line.points.map(rotate);
      items.push({ line: true, player: line.player, rotated, depth: (rotated[0][2] + rotated[1][2]) / 2 + (line.player ? 0.003 : 0.001) });
    }
    for (const node of data.nodes) {
      const point = rotate(node.point);
      items.push({ node: true, point, player: node.player, start: node.start, depth: point[2] + 0.005 });
    }
    items.sort((a, b) => a.depth - b.depth);
    for (const cell of items) {
      const colors = cell.player ? { ...DEFAULT_SURFACE_PALETTE[cell.player], ...palette[cell.player] } : null;
      if (cell.line) {
        const points = cell.rotated.map(project);
        ctx.beginPath(); ctx.moveTo(...points[0]); ctx.lineTo(...points[1]);
        ctx.strokeStyle = colors?.line ?? "rgba(80, 67, 49, 0.42)";
        ctx.lineWidth = cell.player ? Math.max(2 * dpr, scale * 0.025) : Math.max(0.7, dpr);
        ctx.lineCap = "round"; ctx.stroke();
        continue;
      }
      if (cell.node) {
        const point = project(cell.point);
        ctx.beginPath(); ctx.arc(point[0], point[1], Math.max(3 * dpr, scale * 0.035), 0, 2 * Math.PI);
        ctx.fillStyle = colors?.node ?? "#3a3125"; ctx.fill(); ctx.strokeStyle = "#3a3125"; ctx.lineWidth = dpr; ctx.stroke();
        if (cell.start) { ctx.beginPath(); ctx.arc(point[0], point[1], Math.max(5 * dpr, scale * 0.055), 0, 2 * Math.PI); ctx.strokeStyle = colors?.node ?? "#3a3125"; ctx.lineWidth = 1.5 * dpr; ctx.stroke(); }
        continue;
      }
      const points = cell.rotated.map(project);
      ctx.beginPath(); ctx.moveTo(...points[0]); for (const p of points.slice(1)) ctx.lineTo(...p); ctx.closePath();
      // Even translucent custom colors are layered over an opaque surface.
      ctx.fillStyle = NEUTRAL_SURFACE_COLOR; ctx.fill();
      const surfaceColor = palette[cell.player]?.surface ?? palette[cell.player]?.territory ?? colors?.surface;
      if (surfaceColor) { ctx.fillStyle = surfaceColor; ctx.fill(); }
      const shadow = surfaceShadow(cell.rotated);
      if (shadow > 0) { ctx.fillStyle = `rgba(24, 29, 38, ${shadow.toFixed(3)})`; ctx.fill(); }
    }
  };
  const animate = () => { if (destroyed) return; if (!paused && !drag) { yaw += 0.004; draw(); } frame = requestAnimationFrame(animate); };
  const onDown = (event) => { drag = [event.clientX, event.clientY]; canvas.setPointerCapture?.(event.pointerId); };
  const onMove = (event) => { if (!drag) return; yaw += (event.clientX - drag[0]) * 0.01; pitch = Math.max(-1.5, Math.min(1.5, pitch + (event.clientY - drag[1]) * 0.01)); drag = [event.clientX, event.clientY]; draw(); };
  const onUp = () => { drag = null; };
  const onWheel = (event) => { event.preventDefault(); zoom = Math.max(0.5, Math.min(2.5, zoom * Math.exp(-event.deltaY * 0.001))); draw(); };
  const onClick = () => { paused = !paused; updateButton(); draw(); };
  const onZoomOut = () => { zoom = Math.max(0.5, zoom / 1.2); draw(); };
  const onZoomIn = () => { zoom = Math.min(2.5, zoom * 1.2); draw(); };
  const onMotionChange = (event) => { if (event.matches) { paused = true; updateButton(); draw(); } };
  const onKey = (event) => {
    if (event.key === "ArrowLeft") yaw -= 0.12;
    else if (event.key === "ArrowRight") yaw += 0.12;
    else if (event.key === "ArrowUp") pitch = Math.max(-1.5, pitch - 0.12);
    else if (event.key === "ArrowDown") pitch = Math.min(1.5, pitch + 0.12);
    else if (event.key === "+" || event.key === "=") onZoomIn();
    else if (event.key === "-") onZoomOut();
    else return;
    event.preventDefault(); draw();
  };
  canvas.addEventListener("pointerdown", onDown); canvas.addEventListener("pointermove", onMove); canvas.addEventListener("pointerup", onUp); canvas.addEventListener("pointercancel", onUp); canvas.addEventListener("wheel", onWheel, { passive: false }); canvas.addEventListener("keydown", onKey); button.addEventListener("click", onClick); zoomOut.addEventListener("click", onZoomOut); zoomIn.addEventListener("click", onZoomIn); motion?.addEventListener?.("change", onMotionChange);
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(draw) : null;
  observer?.observe(canvas);
  if (!observer) globalThis.addEventListener?.("resize", draw);
  const update = (next, nextOptions = {}) => {
    if (nextOptions.language != null) language = String(nextOptions.language).toLowerCase().startsWith("en") ? "en" : "zh";
    if (nextOptions.palette != null) palette = nextOptions.palette;
    data = buildSurfaceCells(next);
    updateLabels();
    draw();
  };
  updateButton(); update(snapshot); frame = requestAnimationFrame(animate);
  return { backend: depthRenderer ? 'webgl-depth' : 'canvas-approximate', update, destroy() { destroyed = true; depthRenderer?.destroy(); cancelAnimationFrame(frame); observer?.disconnect(); if (!observer) globalThis.removeEventListener?.("resize", draw); motion?.removeEventListener?.("change", onMotionChange); canvas.removeEventListener("pointerdown", onDown); canvas.removeEventListener("pointermove", onMove); canvas.removeEventListener("pointerup", onUp); canvas.removeEventListener("pointercancel", onUp); canvas.removeEventListener("wheel", onWheel); canvas.removeEventListener("keydown", onKey); button.removeEventListener("click", onClick); zoomOut.removeEventListener("click", onZoomOut); zoomIn.removeEventListener("click", onZoomIn); wrapper.remove(); } };
}
