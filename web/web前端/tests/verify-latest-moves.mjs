import assert from 'node:assert/strict';
import GameEngine, { PointState } from '../GameEngine.js?v=20261025-terminal-v4';
import GameController from '../GameController.js?v=20261025-terminal-v4';
import Renderer from '../Renderer.js?v=20261025-terminal-v4';

const noop = () => {};
const settings = { gridSize: 7, playerCount: 3, rulesVersion: 'territory-v3' };
const controller = Object.assign(Object.create(GameController.prototype), {
  options: { engine: settings }, engine: new GameEngine(settings), _engineEpoch: 0,
  _cancelTerritoryRefresh: noop, _scheduleTerritoryRefresh: noop,
  canvas: { style: {}, setAttribute: noop }, _updateLargeBoardClass: noop,
  renderer: { invalidate: noop, render: noop, clearHintPoint: noop },
  multiplayerEnabled: false, lastAction: null, localPlayer: null, networkErrorListener: noop,
});
const actions = [];
const expected = {};
for (let turn = 0; turn < 4; turn++) {
  const actor = controller.engine.currentPlayer;
  const point = controller.engine.getLegalMoves()[0].point;
  assert.equal(controller.applyRemoteMove(point).success, true);
  actions.push({ type: 'player_move', point });
  expected[actor] = [...point];
  assert.deepEqual(controller.getGameState().lastMoves, expected, 'retain one latest move per player');
}
const beforeInvalid = controller.getGameState().lastMoves;
assert.equal(controller.applyRemoteMove([-1, -1]).success, false);
assert.deepEqual(controller.getGameState().lastMoves, beforeInvalid);
const passer = controller.engine.currentPlayer;
assert.equal(controller.applyRemoteSkip().success, true);
actions.push({ type: 'player_skip' });
expected[passer] = null;
assert.deepEqual(controller.getGameState().lastMoves, expected, 'PASS clears only its player');
assert.equal(controller.restoreMatchState({ settings, actions }).success, true);
assert.deepEqual(controller.getGameState().lastMoves, expected, 'restore all players from the action log');
const detached = controller.getGameState().lastMoves;
detached.BLACK[0] = -99;
assert.notEqual(controller.getGameState().lastMoves.BLACK[0], -99);
assert.equal(controller.restoreMatchState({ settings, actions: [...actions, { type: 'player_move', point: [-1, -1] }] }).success, false);
assert.deepEqual(controller.getGameState().lastMoves, expected, 'failed restore preserves highlights');
assert.equal(controller.restoreMatchState({ settings, actions: actions.slice(0, 2) }).success, true);
assert.deepEqual(controller.getGameState().lastMoves, {
  BLACK: actions[0].point, WHITE: actions[1].point,
}, 'undo/replay prefix removes later markers');
assert.equal(controller.restoreMatchState({ settings, actions: [] }).success, true);
assert.deepEqual(controller.getGameState().lastMoves, {}, 'initial nodes are never highlighted');

// Compare metadata with automatic PASS observed from the actual rules. The
// observer does not change any rule result and naturally reaches termination.
const autoSettings = { gridSize: 5, playerCount: 3, rulesVersion: 'territory-v3' };
assert.equal(controller.restoreMatchState({ settings: autoSettings, actions: [] }).success, true);
let autoPasses = 0;
const observed = {};
const originalHasMoves = controller.engine._hasValidMoves;
const skipped = [];
controller.engine._hasValidMoves = function (player) {
  const result = originalHasMoves.call(this, player);
  if (!result) skipped.push(player);
  return result;
};
for (let step = 0; step < 150 && !controller.engine.gameOver; step++) {
  const actor = controller.engine.currentPlayer;
  const point = controller.engine.getLegalMoves()[0]?.point;
  skipped.length = 0;
  const result = point ? controller.applyRemoteMove(point) : controller.applyRemoteSkip();
  assert.equal(result.success, true);
  observed[actor] = point ? [...point] : null;
  for (const player of skipped) { observed[player] = null; autoPasses++; }
  assert.deepEqual(controller.getGameState().lastMoves, observed);
}
assert.ok(autoPasses > 0, 'fixture must reach real automatic PASS');
assert.equal(controller.engine.gameOver, true);
assert.equal(controller.restoreMatchState({ settings, actions: actions.slice(0, 3) }).success, true);
const duplicateResign = [...actions.slice(0, 3), { type: 'player_resign', color: 'WHITE' }, { type: 'player_skip' }];
assert.equal(controller.restoreMatchState({ settings, actions: duplicateResign }).success, true);
const beforeDuplicate = controller.getGameState().lastMoves;
assert.equal(controller.restoreMatchState({ settings, actions: [...duplicateResign, { type: 'player_resign', color: 'WHITE' }] }).success, true);
assert.deepEqual(controller.getGameState().lastMoves, beforeDuplicate, 'duplicate resignation cannot reuse earlier PASS counts');
// Explicit PASS chains retain only the latest action for each seat.
assert.equal(controller.restoreMatchState({ settings, actions: [] }).success, true);
for (let turn = 0; turn < 3; turn++) assert.equal(controller.applyRemoteSkip().success, true);
assert.deepEqual(controller.getGameState().lastMoves, { BLACK: null, WHITE: null, PURPLE: null });
assert.equal(controller.engine.gameOver, true);

// Exercise actual draw calls, including nodes captured since the recorded move.
const arcs = [];
const ctx = new Proxy({}, { get: (_, key) => key === 'arc' ? (...args) => arcs.push(args) : noop, set: () => true });
const renderer = Object.assign(Object.create(Renderer.prototype), { ctx,
  _gridToPixel: (x, y) => [x * 10, y * 10], _getPlayerStyle: () => '#123456', theme: { outline: '#000' } });
const snapshot = { boardMatrix: [[PointState.BLACK_NODE, PointState.WHITE_NODE, PointState.EMPTY]],
  lastMoves: { BLACK: [0, 0], WHITE: [1, 0], PURPLE: [2, 0] }, players: ['BLACK', 'WHITE', 'PURPLE'] };
const layout = { pointRadius: 5, lineWidth: 3 };
renderer._drawLastAction(snapshot, layout);
assert.equal(arcs.length, 6, 'three circles for each surviving latest node');
arcs.length = 0;
renderer._drawLastAction({ ...snapshot, lastMoves: {} }, layout);
assert.equal(arcs.length, 0, 'empty per-player state must not fall back to a stale global move');
assert.notEqual(renderer._getBoardFingerprint(snapshot), renderer._getBoardFingerprint({ ...snapshot, lastMoves: {} }));
console.log('PASS: per-player latest moves, PASS, invalid moves, restore, undo/replay, detached state, captured nodes and render invalidation');
