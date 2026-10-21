import assert from "node:assert/strict";
import GameEngine, { PLAYER_ORDER, TerritoryRulesVersion, getBoardVertices } from "../GameEngine.js";
import Renderer from "../Renderer.js";
import GameController from "../GameController.js";
import { serializeEngineState, deserializeEngineEdges } from "../AIStateProtocol.js";
import { applyTerritoryWorkerResult } from "../TerritoryWorkerSession.js";

const renderer = Object.assign(Object.create(Renderer.prototype), {
  paddingRatio: 0.025,
  topInset: 0,
});
let layoutCases = 0;
for (const playerCount of [4, 5, 6]) {
  for (const gridSize of [5, 9, 15]) {
    const engine = new GameEngine({ playerCount, gridSize, rulesVersion: TerritoryRulesVersion.V2 });
    const snapshot = engine.getSnapshot();
    const board = renderer._collectBoardData(snapshot);
    assert.equal(board.validPoints.length, engine.validPositions.length);
    for (const player of engine.activePlayers) {
      assert.deepEqual(board.nodes[player], [engine.initialPositions[player]]);
    }
    for (const [width, height] of [[286, 250], [390, 340], [1280, 720]]) {
      renderer._lastMeasuredWidth = width;
      renderer._lastMeasuredHeight = height;
      renderer.layout = renderer._computeLayout(snapshot);
      const layout = renderer.layout;
      const pixels = getBoardVertices(gridSize, playerCount).map(([x, y]) => renderer._gridToPixel(x, y));
      const sideLengths = pixels.map((point, i) =>
        Math.hypot(point[0] - pixels[(i + 1) % 6][0], point[1] - pixels[(i + 1) % 6][1]));
      assert.ok(Math.max(...sideLengths) - Math.min(...sideLengths) < 2, "six sides remain equal after pixel rounding");
      for (const [x, y] of pixels) {
        const radius = layout.pointRadius * 1.9;
        assert.ok(x - radius > 0 && x + radius < width, "corner including border fits horizontally");
        assert.ok(y - radius > 0 && y + radius < height, "corner including border fits vertically");
      }
      const controller = Object.assign(Object.create(GameController.prototype), {
        engine, renderer, _validGridPoints: engine.getValidPositions(),
      });
      for (const point of engine.getValidPositions()) {
        const pixel = renderer.getPointPixelCoordinates(point);
        assert.deepEqual(controller._findNearestGridPoint(pixel.x, pixel.y), point, "every hex cell is reachable");
      }
      assert.equal(controller._findNearestGridPoint(0, 0), null, "blank corner does not play a distant move");
      layoutCases += 1;
    }
    const staticHex = renderer._getStaticLayerKey(snapshot, renderer.layout);
    assert.notEqual(staticHex, renderer._getStaticLayerKey({ ...snapshot, playerCount: 2 }, renderer.layout));
  }
}

// Exercise the actual territory worker module with all six edge sets present.
const engine = new GameEngine({ gridSize: 5, playerCount: 6, rulesVersion: TerritoryRulesVersion.V2 });
for (let turn = 0; turn < 18 && !engine.gameOver; turn += 1) {
  const move = engine.getLegalMoves()[0];
  if (move) assert.equal(engine.playMove(move.point).success, true);
  else engine.skipTurn();
}
const state = serializeEngineState(engine);
for (const player of engine.activePlayers) {
  assert.deepEqual([...deserializeEngineEdges(state, engine.activePlayers)[player]], [...engine.edges[player]]);
  assert.ok(state.edges[player].length > 0, `fixture has ${player} edges`);
}
const legacy = { ...state };
delete legacy.edges;
assert.deepEqual([...deserializeEngineEdges(legacy, ["BLACK", "WHITE", "PURPLE"]).PURPLE], state.edgesPurple);
const sourceBefore = JSON.stringify(state);
let response;
const previousSelf = globalThis.self;
globalThis.self = { postMessage: (message) => { response = message; } };
try {
  await import("../TerritoryWorker.js");
  self.onmessage({ data: {
    type: "COMPUTE_TERRITORIES", requestId: "hex-six",
    serializedState: state, territoryStateRevision: engine.getTerritoryStateRevision(),
    gameOver: engine.gameOver,
  } });
} finally {
  if (previousSelf === undefined) delete globalThis.self;
  else globalThis.self = previousSelf;
}
assert.equal(response.type, "RESULT", response.message);
assert.deepEqual(response.territories, engine.cachedTerritories, "worker preserves six-player score and polygon state");
assert.equal(JSON.stringify(serializeEngineState(engine)), sourceBefore, "worker leaves live state unchanged");
assert.equal(applyTerritoryWorkerResult({ engine, ...response }), true);

const controller = Object.assign(Object.create(GameController.prototype), {
  engine, options: { engine: { playerCount: 6 } }, localPlayer: "CYAN",
  multiplayerEnabled: false, _cloneLastAction: () => null,
});
const uiState = controller._buildGameState();
assert.equal(uiState.boardShape, "hexagon");
assert.deepEqual(Object.keys(uiState.scores), PLAYER_ORDER);
assert.equal(uiState.scores.CYAN, engine.cachedTerritories.CYAN.area);
console.log(JSON.stringify({ status: "PASS", layoutCases, sixPlayerWorker: true, scoreAndInput: true }));
