import assert from "node:assert/strict";

// Register the product topology factory before constructing a quotient-board
// GameEngine.  This mirrors the normal module bootstrap without loading Vue.
await import("../TopologyGameEngine.js");

const [
  { default: GameEngine },
  { GameController },
  { applyHintWorkerResult },
  { localPlayerProfile, normalizeLocalPlayers, TOPOLOGY_GENERIC_CHOICE },
  fixtures,
] = await Promise.all([
  import("../GameEngine.js"),
  import("../GameController.js"),
  import("../HintWorkerSession.js"),
  import("../LocalAIModes.js"),
  import("./fixtures/board-topology-v1-fixtures.mjs"),
]);

const { CONCAVE_GAP_DEFINITION } = fixtures;

function makeController(engine) {
  const rendered = [];
  const controller = Object.assign(Object.create(GameController.prototype), {
    engine,
    options: { engine: { gridSize: 5, playerCount: 2, rulesVersion: "territory-v3" } },
    _validGridPoints: engine.getValidPositions(),
    _engineEpoch: 1,
    _authoritativeSnapshotValid: true,
    multiplayerEnabled: false,
    localPlayer: null,
    roomReady: false,
    opponentConnected: false,
    readOnlyMode: false,
    lastAction: null,
    lastMoves: {},
    inspectionOverlay: null,
    renderer: {
      invalidate() {},
      render() {},
    },
    _cancelTerritoryRefresh() {},
    _updateLargeBoardClass() {},
    _syncCanvasInteractivity() {},
    _reportNetworkError() {},
    _syncSnapshot(snapshot, options) {
      rendered.push({ snapshot, options });
    },
    _emitActionFeedback() {},
  });
  return { controller, rendered };
}

// A saved topology game must restore its complete state, rather than infer an
// opening from the player who happened to be to move when the tab closed.
const savedEngine = new GameEngine({
  boardDefinition: CONCAVE_GAP_DEFINITION,
  playerCount: 2,
  startPlayer: "WHITE",
  rulesVersion: "surface-v1",
});
assert.equal(savedEngine.currentPlayer, "WHITE");
const whiteMove = savedEngine.getLegalMoves().at(0)?.vertexId;
assert.equal(typeof whiteMove, "string");
assert.equal(savedEngine.playMove(whiteMove).success, true);
const savedState = savedEngine.encodeTopologyState();
const savedSnapshot = savedEngine.getSnapshot();

const { controller, rendered } = makeController(new GameEngine({ gridSize: 5, playerCount: 2 }));
const restored = controller.restoreTopologyState(savedState, {
  startPlayer: "WHITE",
  lastAction: { type: "move", player: "WHITE", vertexId: whiteMove },
});
assert.equal(restored.success, true, restored.reason);
assert.equal(controller.engine.isTopologyBoard, true);
assert.equal(controller.engine.startPlayer, "WHITE");
assert.equal(controller.engine.boardHash, savedEngine.boardHash);
assert.equal(controller.engine.currentPlayer, savedEngine.currentPlayer);
assert.equal(controller.engine.positionRevision, savedEngine.positionRevision);
assert.deepEqual([...controller.engine.historyHashes].sort(), [...savedEngine.historyHashes].sort());
assert.deepEqual(controller.engine.getSnapshot().boardStates, savedSnapshot.boardStates);
assert.equal(controller.lastAction.point, whiteMove);
assert.equal(rendered.length, 1, "a successful direct restore must refresh the controller snapshot once");
assert.equal(rendered[0].options.forceRender, true);
assert.equal(rendered[0].options.scheduleTerritory, false);

const preservedEngine = controller.engine;
const corruptState = structuredClone(savedState);
corruptState.boardHash = "0".repeat(64);
const rejected = controller.restoreTopologyState(corruptState, { startPlayer: "WHITE" });
assert.equal(rejected.success, false);
assert.equal(controller.engine, preservedEngine, "a rejected saved state must retain the active board");

// A custom board must not silently select a fixed-shape model.  The Worker
// contract returns canonical string IDs, and both move application and the
// hint display path must retain that identity rather than coerce it to [x, y].
const customPlayers = normalizeLocalPlayers({
  BLACK: { choice: "greedy" },
  WHITE: { choice: "ai-hard" },
}, 2, "custom");
assert.equal(customPlayers.BLACK.choice, TOPOLOGY_GENERIC_CHOICE);
assert.equal(customPlayers.WHITE.choice, TOPOLOGY_GENERIC_CHOICE);
assert.deepEqual(
  localPlayerProfile(customPlayers.BLACK, 2, 9, "custom"),
  { strategy: TOPOLOGY_GENERIC_CHOICE },
);

const aiEngine = new GameEngine({ boardDefinition: CONCAVE_GAP_DEFINITION });
const canonicalMove = aiEngine.getLegalMoves().at(0)?.vertexId;
assert.equal(typeof canonicalMove, "string");
const { controller: aiController } = makeController(aiEngine);
const workerMove = {
  type: "move",
  point: canonicalMove,
  vertexId: canonicalMove,
  boardHash: aiEngine.boardHash,
};
assert.equal(aiEngine._evaluateMove(workerMove.vertexId, aiEngine.currentPlayer).legal, true);
const renderedHints = [];
const hintResult = applyHintWorkerResult({
  moves: [workerMove],
  legalMoves: aiEngine.getSnapshot().legalMoves,
  remainingCount: 1,
  renderHint: (vertexId) => renderedHints.push(vertexId),
});
assert.equal(hintResult.applied, true);
assert.equal(hintResult.point, canonicalMove);
assert.deepEqual(renderedHints, [canonicalMove]);

const applied = aiController._applyMove(workerMove.vertexId, aiEngine.currentPlayer);
assert.equal(applied.success, true);
assert.equal(aiController.lastAction.point, canonicalMove);

console.log(JSON.stringify({
  status: "PASS",
  coverage: [
    "direct isolated topology-session restore preserves white opening and full rule state",
    "corrupt topology state leaves the live controller engine intact",
    "custom-board players use the explicit topology-generic route",
    "canonical string worker moves and hints retain vertex identity",
  ],
  scope: "Node integration only; not a Vue/Chrome or two-client WebSocket acceptance test.",
}));
