import test from 'node:test';
import assert from 'node:assert/strict';
import { sut } from './helpers.mjs';

function drawing(snapshot, layout, options = {}) {
  const calls = [], styles = {};
  const ctx = new Proxy({}, {
    get: (_, name) => (...args) => calls.push({ name, args, styles: { ...styles } }),
    set: (_, name, value) => { styles[name] = value; return true; },
  });
  sut.drawBoard(ctx, { ...snapshot, legalMoves: [] }, layout, options);
  return calls;
}
const labels = calls => calls.filter(call => call.name === 'fillText');
function assertRoots(snapshot, layout, options) {
  const before = JSON.stringify(snapshot), calls = drawing(snapshot, layout, options), markers = labels(calls);
  assert.equal(markers.length, snapshot.players.length);
  for (const [index, player] of snapshot.players.entries()) {
    assert.deepEqual(markers[index].args, [String(sut.PLAYER_ORDER.indexOf(player) + 1), ...sut.toScreen(snapshot.initialPositions[player], layout)]);
    assert.equal(markers[index].styles.fillStyle, '#ffffff');
    assert.match(markers[index].styles.font, /^bold /);
    assert.deepEqual(sut.hitPoint(...markers[index].args.slice(1), layout), snapshot.initialPositions[player]);
  }
  assert.equal(JSON.stringify(snapshot), before, 'rendering does not mutate the live or replay position');
  return calls;
}

test('each saved default, random and custom root keeps its seat number on triangle/hexagon overviews and zooms', () => {
  let seed = 0x2310;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  for (const boardShape of ['triangle', 'hexagon']) for (const playerCount of [2, 3, 4, 5, 6]) {
    for (const gridSize of [5, 15]) for (const mode of ['default', 'random', 'custom']) {
      const points = sut.getBoardPositions(gridSize, playerCount, boardShape);
      const initialPositions = mode === 'random' ? sut.randomInitialPositions(gridSize, playerCount, random, boardShape)
        : mode === 'custom' ? Object.fromEntries(sut.PLAYER_ORDER.slice(0, playerCount).map((player, i) => [player, points[i + 2]])) : undefined;
      const engine = new sut.GameEngine({ ...sut.settingsFor(gridSize, playerCount), boardShape, initialPositions });
      const snapshot = engine.getSnapshot(), rect = { x: 30, y: 200, width: 260, height: 210 };
      assertRoots(snapshot, sut.boardLayout(gridSize, rect, playerCount, boardShape));
      assertRoots(snapshot, sut.focusBoardLayout(gridSize, rect, snapshot.initialPositions.BLACK, 44, playerCount, boardShape),
        { display: { ...sut.DEFAULT_DISPLAY, highContrast: true, territories: false, legalMoves: false, lastMove: false } });
    }
  }
});

test('root markers survive moves, resignation and replay; selection overlays stay above the markers', () => {
  const initialPositions = { BLACK: [2, 1], WHITE: [1, 2], PURPLE: [2, 2] };
  const engine = new sut.GameEngine({ ...sut.settingsFor(7, 3), initialPositions });
  const initial = engine.getSnapshot(), move = engine.getLegalMoves()[0].point;
  assert.equal(engine.playMove(move).success, true);
  assert.equal(engine.resignPlayer('WHITE').success, true);
  const current = engine.getSnapshot(), layout = sut.boardLayout(7, { x: 30, y: 200, width: 330, height: 300 }, 3);
  assertRoots(current, layout); assertRoots(initial, layout);
  const p = sut.toScreen(initialPositions.BLACK, layout), calls = assertRoots(current, layout, { selected: initialPositions.BLACK });
  assert.ok(calls.findLastIndex(call => call.name === 'arc' && call.args[0] === p[0] && call.args[1] === p[1])
    > calls.findLastIndex(call => call.name === 'fillText'), 'selected-point outline is drawn over every marker');
});

test('dense adjacent roots fit within separate cells and the default snapshot fallback stays compatible', () => {
  const initialPositions = { BLACK: [14, 14], WHITE: [15, 14], PURPLE: [16, 14], GREEN: [14, 15], ORANGE: [15, 15], CYAN: [16, 15] };
  const engine = new sut.GameEngine({ ...sut.settingsFor(15, 6), initialPositions });
  const layout = sut.boardLayout(15, { x: 30, y: 200, width: 260, height: 210 }, 6);
  const calls = assertRoots(engine.getSnapshot(), layout);
  for (const marker of labels(calls)) {
    const index = calls.indexOf(marker), rings = calls.slice(0, index).filter(call => call.name === 'arc' && call.args[0] === marker.args[1] && call.args[1] === marker.args[2]).slice(-2);
    assert.equal(rings.length, 2);
    assert.ok(rings.every(ring => ring.args[2] < layout.spacing / 2));
    assert.ok(Number.parseFloat(marker.styles.font.slice(5)) >= 5);
  }
  const defaultSnapshot = new sut.GameEngine(sut.settingsFor(5)).getSnapshot(), oldSnapshot = { ...defaultSnapshot };
  delete oldSnapshot.initialPositions;
  const oldLayout = sut.boardLayout(5, { x: 30, y: 200, width: 260, height: 210 });
  assert.deepEqual(labels(drawing(oldSnapshot, oldLayout)).map(item => item.args), labels(drawing(defaultSnapshot, oldLayout)).map(item => item.args));
});
