import assert from 'node:assert/strict';
import { generateBoard, randomBoardGeometrySignature } from '../RandomBoard.js';
import { createDoubleTorusBoardDefinition, createDoubleSphereBoardDefinition, isRandomSurfaceManifold } from '../RandomSurfaceBoard.js';
import { compileBoardOrThrow } from '../BoardCompiler.js';
import { analyzeBoardAlgebra } from '../TopologyAlgebra.js';
import { identifySurface, surfacePosition, buildSurfaceCells, mountTopologySurface3D } from '../TopologySurface3D.js';
import '../TopologyGameEngine.js';
import { GameEngine } from '../GameEngine.js';

for (const [n, counts] of [[5, [28, 90, 60]], [9, [124, 378, 252]], [15, [388, 1170, 780]]]) {
  const d = createDoubleTorusBoardDefinition({ gridSize: n }), board = compileBoardOrThrow(d);
  assert.deepEqual([board.canonicalVertices.length, board.edgeClasses.length, d.faces.length], counts);
  assert.ok(isRandomSurfaceManifold(board, 'double-torus'));
  assert.deepEqual(analyzeBoardAlgebra(board).betti, [1, 4, 1]);
}
for (let n = 5; n <= 15; n++) {
  const definition = createDoubleSphereBoardDefinition({ gridSize: n });
  const board = compileBoardOrThrow(definition);
  assert.ok(isRandomSurfaceManifold(board, 'sphere'));
  assert.deepEqual(analyzeBoardAlgebra(board).betti, [1, 0, 1]);
  const front = definition.vertices.filter(v => !v.id.startsWith('back:'));
  assert.equal(Math.max(...front.map(v => v.coordinate[0])) + 1, n);
  assert.equal(Math.max(...front.map(v => v.coordinate[1])) + 1, n);
  definition.generator = { generatorVersion: 'random-board-v4', options: { gridSize: n } };
  assert.equal(identifySurface(definition).kind, 'double-sphere');
}
const seen = new Map();
for (let i = 0; i < 160; i++) {
  const result = generateBoard({ gridSize: 5, playerCount: 2 }, `surface-${i}`);
  assert.ok(result.ok, JSON.stringify(result));
  const board = compileBoardOrThrow(result.definition);
  assert.equal(board.boardHash, result.boardHash);
  assert.ok(isRandomSurfaceManifold(board, result.stats.category));
  if (result.stats.category === 'double-torus') assert.equal(identifySurface(result.definition).kind, 'double-torus');
  if (result.stats.category === 'sphere') assert.equal(identifySurface(result.definition).kind, 'double-sphere');
  seen.set(result.stats.category, (seen.get(result.stats.category) ?? 0) + 1);
}
assert.equal(seen.size, 9, JSON.stringify([...seen]));
for (const n of [9, 15]) {
  const variants = new Map(['disk', 'annulus', 'planar-two-holes', 'double-torus'].map(kind => [kind, new Set()]));
  for (let i = 0; i < 220 && [...variants.values()].some(values => values.size < 2); i++) {
    const result = generateBoard({ gridSize: n, playerCount: 2 }, `variation-${i}`);
    assert.ok(result.ok, JSON.stringify(result));
    variants.get(result.stats.category)?.add(randomBoardGeometrySignature(result.definition));
  }
  for (const [kind, values] of variants) assert.ok(values.size >= 2, `${n} ${kind} has only ${values.size} geometry`);
}
for (let n = 5; n <= 15; n++) for (const count of [2, 3, 4, 5, 6]) {
  const opts = { gridSize: n, playerCount: count };
  const result = generateBoard(opts, 'sizes-and-seats');
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(generateBoard(opts, 'sizes-and-seats'), result);
  const game = new GameEngine({ boardDefinition: result.definition, playerCount: count });
  for (const player of game.activePlayers) assert.ok(game.getLegalMoves(player).length, `${n} ${count} ${player}`);
}
let double;
for (let i = 0; i < 300 && !double; i++) {
  const candidate = generateBoard({ gridSize: 5, playerCount: 2 }, `double-${i}`);
  if (candidate.stats.category === 'double-torus') double = candidate;
}
assert.ok(double);
const shape = identifySurface(double.definition), board = compileBoardOrThrow(double.definition);
assert.equal(shape.kind, 'double-torus');
const raw = new Map(double.definition.vertices.map(v => [v.id, v.coordinate]));
for (const pair of double.definition.seamPairs) {
  const occurrences = board.edgeOccurrences.filter(o => o.id === pair.edgeOccurrenceA || o.id === pair.edgeOccurrenceB);
  const [a, b] = occurrences;
  for (let endpoint = 0; endpoint < 2; endpoint++) {
    const left = surfacePosition(shape, raw.get(a.vertices[endpoint]), {}, a.faceId);
    const right = surfacePosition(shape, raw.get(b.vertices[pair.endpointMap[endpoint]]), {}, b.faceId);
    assert.ok(left.every((v, j) => Math.abs(v - right[j]) < 1e-9));
  }
}
for (const face of double.definition.faces) {
  const coords = face.vertices.map(v => raw.get(v));
  const center = [0, 1].map(k => coords.reduce((s, p) => s + p[k], 0) / 3);
  const point = surfacePosition(shape, center, {}, face.id);
  assert.ok(point && (face.id.startsWith('back:') ? point[2] < -1e-8 : point[2] > 1e-8), face.id);
}
const game = new GameEngine({ boardDefinition: double.definition });
const move = game.getLegalMoves()[0]; assert.ok(move && game.playMove(move.point).success);
const mesh = buildSurfaceCells(game.getSnapshot());
assert.ok(mesh.cells.length && mesh.cells.every(cell => cell.points.every(Boolean)));
assert.ok(mesh.lines.length && mesh.lines.every(line => line.points.every(Boolean)));
assert.ok(mesh.nodes.length && mesh.nodes.every(node => node.point));
// Exercise the WebGL branch with a strict mock; real GPU occlusion is a
// separate browser/device check, not established by this API-level assertion.
const calls = [];
const gl = new Proxy({ DEPTH_TEST: 1, TRIANGLES: 2, LINES: 3, POINTS: 4, COMPILE_STATUS: 5, LINK_STATUS: 6,
  getShaderParameter: () => true, getProgramParameter: () => true,
  enable: value => calls.push(['enable', value]), drawArrays: (mode, start, count) => calls.push(['draw', mode, count]),
}, { get: (target, key) => key in target ? target[key] : () => ({}) });
class Element {
  constructor() { this.style = {}; this.children = []; }
  append(...children) { this.children.push(...children); }
  setAttribute() {} addEventListener() {} removeEventListener() {} remove() {}
  getContext(kind) { return kind === 'webgl' ? gl : null; }
  getBoundingClientRect() { return { width: 300, height: 240 }; }
}
const old = Object.fromEntries(['document', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, globalThis[key]]));
try {
  globalThis.document = { createElement: () => new Element() };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const container = new Element(), viewer = mountTopologySurface3D(container, game.getSnapshot());
  assert.ok(calls.some(call => call[0] === 'enable' && call[1] === gl.DEPTH_TEST));
  for (const mode of [gl.TRIANGLES, gl.LINES, gl.POINTS]) assert.ok(calls.some(call => call[0] === 'draw' && call[1] === mode && call[2] > 0));
  assert.ok(!container.children[0].children[0].textContent.includes('深度缓冲不可用'));
  viewer.destroy();
} finally {
  for (const [key, value] of Object.entries(old)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
}
assert.equal(generateBoard({ maxAttempts: 0 }, 'none').errors[0].code, 'ATTEMPT_BUDGET_EXHAUSTED');
console.log('random surface v4: PASS', JSON.stringify(Object.fromEntries(seen)));
