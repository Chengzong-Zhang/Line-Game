import assert from 'node:assert/strict';
import GameEngine, { PointState, PLAYER_ORDER } from '../GameEngine.js?v=20261025-defense15';
import GameController from '../GameController.js?v=20261025-defense15';
import Renderer from '../Renderer.js?v=20261025-defense15';
import { randomInitialPositions } from '../StartingPoints.js';

const noop = () => {};
const totals = { actions: 0, automaticPasses: 0, resignations: 0, rollbackCases: 0 };

for (let playerCount = 2; playerCount <= PLAYER_ORDER.length; playerCount += 1) {
  const settings = {
    gridSize: 5, playerCount, rulesVersion: 'territory-v3',
    boardShape: playerCount >= 4 ? 'hexagon' : 'triangle',
    deferTerritoryUpdates: true,
  };
  if (playerCount > 6) {
    settings.initialPositions = randomInitialPositions(5, playerCount, () => 0.37, 'hexagon');
  }
  const controller = Object.assign(Object.create(GameController.prototype), {
    options: { engine: settings }, engine: new GameEngine(settings), _engineEpoch: 0,
    _cancelTerritoryRefresh: noop, _scheduleTerritoryRefresh: noop,
    canvas: { style: {}, setAttribute: noop }, _updateLargeBoardClass: noop,
    renderer: { invalidate: noop, render: noop, clearHintPoint: noop },
    multiplayerEnabled: false, lastAction: null, lastMoves: {},
    networkErrorListener: noop,
  });

  // Observe actual no-legal-move decisions without changing their outcome.
  // This oracle does not infer passes from consecutiveSkips like the controller.
  const expected = {}, skipped = [];
  const hasValidMoves = controller.engine._hasValidMoves;
  controller.engine._hasValidMoves = function (player) {
    const available = hasValidMoves.call(this, player);
    if (!available) skipped.push(player);
    return available;
  };

  for (let step = 0; step < 45 && !controller.engine.gameOver; step += 1) {
    skipped.length = 0;
    const actor = controller.engine.currentPlayer;
    const point = controller.engine.getLegalMoves()[0]?.point;
    let result;
    if (step % 13 === 12 && controller.engine._getRemainingPlayers().length > 2) {
      const target = controller.engine._getNextPlayer(actor);
      result = controller.applyRemoteResign(target);
      expected[target] = null;
      totals.resignations += 1;
    } else if (step % 7 === 6 || !point) {
      result = controller.applyRemoteSkip();
      expected[actor] = null;
    } else {
      result = controller.applyRemoteMove(point);
      expected[actor] = [...point];
    }
    const context = `${playerCount} seats, action ${step + 1}`;
    assert.equal(result.success, true, context);
    for (const player of skipped) {
      expected[player] = null;
      totals.automaticPasses += 1;
    }
    assert.deepEqual(controller.getGameState().lastMoves, expected, context);

    // Check the renderer chooses only surviving nodes owned by their marker.
    const drawn = [];
    const renderer = Object.assign(Object.create(Renderer.prototype), {
      _drawLatestMove: action => drawn.push(action.player),
    });
    const snapshot = controller.getGameState().snapshot;
    renderer._drawLastAction({ ...snapshot, lastMoves: controller.getGameState().lastMoves }, {});
    const visible = Object.entries(expected).filter(([player, marked]) => marked
      && !snapshot.resignedPlayers.includes(player)
      && snapshot.boardMatrix[marked[1]]?.[marked[0]] === PointState[`${player}_NODE`])
      .map(([player]) => player);
    assert.deepEqual(drawn, visible, context);
    totals.actions += 1;
  }

  const previousEngine = controller.engine;
  const previousState = controller.getGameState();
  for (const territoryPending of [true, false]) {
    let rendered;
    controller.renderer.render = snapshot => { rendered = snapshot; };
    controller._syncSnapshot({ ...previousState.snapshot, territoryPending }, { scheduleTerritory: false });
    assert.deepEqual(rendered.lastMoves, previousState.lastMoves, 'territory refresh preserves markers');
  }
  const invalid = controller.restoreMatchState({
    settings, actions: [{ type: 'player_move', point: [-1, -1] }],
  });
  assert.equal(invalid.success, false);
  assert.equal(controller.engine, previousEngine);
  assert.deepEqual(controller.getGameState().lastMoves, previousState.lastMoves);
  totals.rollbackCases += 1;

  controller.renderer.render = () => { throw new Error('injected render failure'); };
  assert.equal(controller.restoreMatchState({ settings, actions: [] }).success, false);
  assert.equal(controller.engine, previousEngine);
  assert.deepEqual(controller.getGameState().lastAction, previousState.lastAction);
  assert.deepEqual(controller.getGameState().lastMoves, previousState.lastMoves);
  totals.rollbackCases += 1;
}

assert.ok(totals.automaticPasses > 0, 'fixtures must reach real automatic passes');
assert.ok(totals.resignations > 0, 'fixtures must include resignations');
assert.equal(totals.rollbackCases, 2 * (PLAYER_ORDER.length - 1), 'both replay and render failures covered for every supported seat count');
console.log(`PASS: latest moves across 2..${PLAYER_ORDER.length} seats; ${JSON.stringify(totals)}`);
