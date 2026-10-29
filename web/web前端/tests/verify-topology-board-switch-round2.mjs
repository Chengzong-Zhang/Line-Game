import assert from "node:assert/strict";
import "../TopologyGameEngine.js";
import GameEngine from "../GameEngine.js";
import GameController from "../GameController.js";
import { createSurfacePreset } from "../BoardPresets.js";
import { compileBoard } from "../BoardCompiler.js";

const noop = () => {};
const definition = createSurfacePreset("tetrahedron", { gridSize: 9 });
const initialOptions = {
  boardShape: "custom", boardDefinition: definition,
  rulesVersion: "surface-v1", playerCount: 2, gridSize: 9,
};
let cancelled = 0;
const controller = Object.assign(Object.create(GameController.prototype), {
  options: { engine: initialOptions }, engine: new GameEngine(initialOptions),
  _engineEpoch: 1, renderer: { invalidate: noop },
  _cancelTerritoryRefresh: () => { cancelled += 1; },
  _syncSnapshot: noop, _updateLargeBoardClass: noop,
  multiplayerEnabled: false, localPlayer: null, lastAction: null, lastMoves: {},
});

// Reproduce the user path: a completed surface match, then the shape controls
// select an ordinary board whose settings naturally omit boardDefinition.
controller.engine.skipTurn();
controller.engine.skipTurn();
assert.equal(controller.engine.getSnapshot().gameOver, true);
for (const shape of ["triangle", "hexagon"]) {
  const state = controller.setGameConfig({ boardShape: shape, gridSize: 5, playerCount: 2, rulesVersion: "territory-v3" });
  assert.equal(state.isTopologyBoard, false);
  assert.equal(state.boardShape, shape);
  assert.equal(state.snapshot.gridSize, 5);
  assert.equal(state.rulesVersion, "territory-v3");
  assert.equal(state.gameOver, false);
  for (const key of ["boardDefinition", "compiledBoard", "boardHash", "topologyProtocolVersion"]) {
    assert.equal(Object.hasOwn(controller.options.engine, key), false, `stale ${key}`);
  }
  const move = controller.engine.getSnapshot().legalMoves[0];
  assert.ok(move, `${shape} has a real opening move`);
  assert.equal(controller.engine.playMove(move.point).success, true);
}

// A definition-bearing request supplies a new board identity and defaults to
// its surface rule family, even after a territory-v3 game.
const cylinder = createSurfacePreset("cylinder", { gridSize: 5 });
const compiled = compileBoard(cylinder);
assert.equal(compiled.ok, true);
controller.setGameConfig({ compiledBoard: compiled.value, gridSize: 5, playerCount: 2 });
assert.equal(controller.engine.isTopologyBoard, true);
assert.equal(controller.engine.rulesVersion, "surface-v1");
const oldHash = controller.engine.boardHash;
controller.setGameConfig({ boardDefinition: definition, gridSize: 9, playerCount: 2 });
assert.notEqual(controller.engine.boardHash, oldHash);
assert.equal(Object.hasOwn(controller.options.engine, "compiledBoard"), false);
const tetrahedronHash = controller.engine.boardHash;
controller.setGameConfig({ boardShape: "custom", playerCount: 2, startPlayer: "WHITE" });
assert.equal(controller.engine.boardHash, tetrahedronHash, "partial surface settings retain the selected geometry");
assert.equal(controller.engine.currentPlayer, "WHITE");

// Reject an invalid candidate before cancelling work or replacing any live
// state/configuration. The existing game must still accept a legal move.
const savedEngine = controller.engine;
const savedOptions = controller.options.engine;
const savedEpoch = controller._engineEpoch;
const cancelledBefore = cancelled;
assert.throws(() => controller.setGameConfig({ boardShape: "custom", boardDefinition: { invalid: true }, rulesVersion: "surface-v1" }));
assert.equal(controller.engine, savedEngine);
assert.equal(controller.options.engine, savedOptions);
assert.equal(controller._engineEpoch, savedEpoch);
assert.equal(cancelled, cancelledBefore);
controller.renderer.invalidate = () => { throw new Error("renderer unavailable"); };
assert.throws(() => controller.setGameConfig({ boardShape: "triangle", gridSize: 5 }), /renderer unavailable/);
assert.equal(controller.engine, savedEngine);
assert.equal(controller.options.engine, savedOptions);
assert.equal(controller._engineEpoch, savedEpoch);
assert.equal(cancelled, cancelledBefore);
controller.renderer.invalidate = noop;
const validMove = controller.engine.getSnapshot().legalMoves[0];
assert.equal(controller.engine.playMove(validMove.vertexId).success, true);

// With no explicit legacy version, leaving a surface starts the ordinary v3
// family, while explicitly supplied old replay versions remain supported.
assert.equal(controller.setGameConfig({ boardShape: "triangle", gridSize: 5 }).rulesVersion, "territory-v3");
assert.equal(controller.setGameConfig({ boardShape: "hexagon", gridSize: 5, rulesVersion: "territory-v2" }).rulesVersion, "territory-v2");
console.log("PASS topology/triangle/hexagon switch and atomic invalid configuration");
