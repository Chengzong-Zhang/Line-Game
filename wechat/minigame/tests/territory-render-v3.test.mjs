import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, plain } from './helpers.mjs';

function render(snapshot, layout) {
  const calls = [], styles = {};
  const ctx = new Proxy({}, {
    get: (_, name) => (...args) => calls.push({ name, args, styles: { ...styles } }),
    set: (_, name, value) => { styles[name] = value; return true; },
  });
  sut.drawBoard(ctx, snapshot, layout, {
    display: { ...sut.DEFAULT_DISPLAY, legalMoves: false, lastMove: false },
  });
  return calls;
}

function territorySubpaths(calls, color) {
  const fillIndex = calls.findIndex(call => call.name === 'fill' && call.styles.fillStyle === `${color}25`);
  assert.notEqual(fillIndex, -1, `missing territory fill for ${color}`);
  let beginIndex = fillIndex;
  while (beginIndex >= 0 && calls[beginIndex].name !== 'beginPath') beginIndex--;
  assert.ok(beginIndex >= 0);
  const paths = [];
  for (const call of calls.slice(beginIndex + 1, fillIndex)) {
    if (call.name === 'moveTo') paths.push([call.args]);
    else if (call.name === 'lineTo') paths.at(-1)?.push(call.args);
  }
  return paths;
}

function centers(paths) {
  return paths.map(path => path.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0])
    .map(value => value / path.length));
}

function includesPoint(points, target, epsilon = 1e-7) {
  return points.some(point => Math.abs(point[0] - target[0]) < epsilon && Math.abs(point[1] - target[1]) < epsilon);
}

function fixture(renderPoints, { enemyAt = null, polygon = null, rulesVersion = 'territory-v3' } = {}) {
  const engine = new sut.GameEngine(sut.settingsFor(7));
  const snapshot = plain(engine.getSnapshot());
  snapshot.rulesVersion = rulesVersion;
  snapshot.legalMoves = [];
  snapshot.edges = { BLACK: [], WHITE: [], PURPLE: [] };
  snapshot.territories = {
    BLACK: { area: renderPoints.length, displayArea: 0, polygon, renderPoints },
    WHITE: { area: 0, displayArea: 0, polygon: null, renderPoints: [] },
  };
  // The renderer's public board-state contract uses 3 for a WHITE node.
  if (enemyAt) snapshot.boardMatrix[enemyAt[1]][enemyAt[0]] = 3;
  return snapshot;
}

const layout = sut.boardLayout(7, { x: 24, y: 30, width: 420, height: 360 });
const hole = [3, 2];
const engine = new sut.GameEngine(sut.settingsFor(7));
const ring = engine.getAdjacentPositions(hole);

test('territory-v3 donut paints every scored hexagon, including its safe center', () => {
  const points = [...ring, hole];
  const snapshot = fixture(points);
  const before = JSON.stringify(snapshot), calls = render(snapshot, layout);
  const paths = territorySubpaths(calls, sut.COLORS.BLACK);
  assert.equal(paths.length, points.length);
  assert.ok(paths.every(path => path.length === 6), 'each scored point is one six-sided cell');
  assert.ok(includesPoint(centers(paths), sut.toScreen(hole, layout)), 'the donut center is visibly filled');
  assert.equal(JSON.stringify(snapshot), before, 'drawing does not mutate the snapshot');
});

test('separate safe cavities are both painted from one renderPoints set', () => {
  const holes = [[1, 1], [4, 1]];
  const points = [...new Map(holes.flatMap(center => [...engine.getAdjacentPositions(center), center])
    .map(point => [point.join(','), point])).values()];
  const paths = territorySubpaths(render(fixture(points), layout), sut.COLORS.BLACK);
  const painted = centers(paths);
  assert.equal(paths.length, points.length);
  for (const center of holes) assert.ok(includesPoint(painted, sut.toScreen(center, layout)));
});

test('an enemy-occupied donut hole is omitted from the rendered territory', () => {
  const snapshot = fixture(ring, { enemyAt: hole });
  const paths = territorySubpaths(render(snapshot, layout), sut.COLORS.BLACK);
  assert.equal(paths.length, ring.length);
  assert.equal(includesPoint(centers(paths), sut.toScreen(hole, layout)), false);
});

test('an open chain paints its counted points without inventing an enclosure', () => {
  const chain = [[0, 0], [1, 0], [2, 0]];
  const paths = territorySubpaths(render(fixture(chain), layout), sut.COLORS.BLACK);
  const painted = centers(paths);
  assert.equal(paths.length, chain.length);
  for (const point of chain) assert.ok(includesPoint(painted, sut.toScreen(point, layout)));
  assert.equal(includesPoint(painted, sut.toScreen([1, 1], layout)), false);
});

test('legacy polygon snapshots keep the original single-path fallback', () => {
  const polygon = [[0, 0], [2, 0], [0, 2]];
  const paths = territorySubpaths(render(fixture([], { polygon, rulesVersion: 'territory-v2' }), layout), sut.COLORS.BLACK);
  assert.equal(paths.length, 1);
  assert.equal(paths[0].length, polygon.length);
});
