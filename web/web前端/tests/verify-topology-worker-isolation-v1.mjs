import assert from "node:assert/strict";

// Register the topology factory just as main.js does before it imports the
// application.  The test intentionally exercises the real quotient engine,
// rather than a topology-shaped mock object.
await import("../TopologyGameEngine.js");

const [
  { default: GameEngine },
  { GameController },
  { OneShotHintWorker, applyHintWorkerResult },
  { serializeEngineState },
  fixtures,
] = await Promise.all([
  import("../GameEngine.js"),
  import("../GameController.js"),
  import("../HintWorkerSession.js"),
  import("../AIStateProtocol.js"),
  import("./fixtures/board-topology-v1-fixtures.mjs"),
]);

const { CONCAVE_GAP_DEFINITION } = fixtures;

function createTopologyEngine(options = {}) {
  const engine = new GameEngine({
    boardDefinition: CONCAVE_GAP_DEFINITION,
    playerCount: 2,
    rulesVersion: "surface-v1",
    ...options,
  });
  assert.equal(engine.isTopologyBoard, true);
  return engine;
}

class FakeWorker {
  constructor() {
    this.messages = [];
    this.terminateCount = 0;
    this.onmessage = null;
    this.onerror = null;
  }

  postMessage(message) {
    this.messages.push(structuredClone(message));
  }

  terminate() {
    this.terminateCount += 1;
  }

  emit(data) {
    this.onmessage?.({ data });
  }
}

function createHintResponse(worker, engine, move, overrides = {}) {
  return {
    type: "RESULT",
    requestId: worker.messages.at(0)?.requestId,
    positionRevision: engine.positionRevision,
    rulesVersion: engine.rulesVersion,
    currentPlayer: engine.currentPlayer,
    boardHash: engine.boardHash,
    moves: [{ vertexId: move }],
    ...overrides,
  };
}

// A topology hint must retain canonical string identity from serialized state,
// through the worker result, all the way to the renderer callback.
{
  const engine = createTopologyEngine();
  const canonicalMove = engine.getSnapshot().legalMoves.at(0)?.vertexId;
  assert.equal(typeof canonicalMove, "string");
  const workers = [];
  const session = new OneShotHintWorker(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  const applied = [];
  const finishes = [];
  const requestId = session.start({
    engine,
    getCurrentEngine: () => engine,
    message: {
      type: "COMPUTE",
      strategy: "topology-generic",
      serializedState: serializeEngineState(engine),
      aiPlayer: engine.currentPlayer,
      depth: 2,
      topN: 1,
    },
    onResult: (result) => {
      const rendered = applyHintWorkerResult({
        moves: result.moves,
        legalMoves: engine.getSnapshot().legalMoves,
        remainingCount: 1,
        renderHint: (vertexId) => applied.push(vertexId),
      });
      assert.equal(rendered.applied, true);
    },
    onFinish: (outcome) => finishes.push(outcome),
  });
  const worker = workers[0];
  assert.equal(worker.messages.length, 1);
  assert.equal(worker.messages[0].strategy, "topology-generic");
  assert.equal(worker.messages[0].serializedState.isTopologyBoard, true);
  assert.equal(worker.messages[0].serializedState.boardHash, engine.boardHash);
  assert.equal("gridEntries" in worker.messages[0].serializedState, false,
    "quotient boards must not be serialized as a legacy matrix");

  worker.emit(createHintResponse(worker, engine, canonicalMove));
  assert.deepEqual(applied, [canonicalMove]);
  assert.deepEqual(finishes, [{ status: "result", requestId }]);
  assert.equal(worker.terminateCount, 1);
}

// Neither a response carrying a different board identity nor a response to an
// older position may render a hint after a topology board changes.
for (const staleCase of [
  {
    name: "board hash",
    mutate: () => {},
    response: { boardHash: "0".repeat(64) },
  },
  {
    name: "position revision",
    mutate: (engine) => { engine.positionRevision += 1; },
    response: {},
  },
]) {
  const engine = createTopologyEngine();
  const move = engine.getSnapshot().legalMoves.at(0)?.vertexId;
  const workers = [];
  const session = new OneShotHintWorker(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  const results = [];
  const finishes = [];
  const requestId = session.start({
    engine,
    getCurrentEngine: () => engine,
    message: { type: "COMPUTE", serializedState: serializeEngineState(engine) },
    onResult: (result) => results.push(result),
    onFinish: (outcome) => finishes.push(outcome),
  });
  const worker = workers[0];
  const response = createHintResponse(worker, engine, move, staleCase.response);
  staleCase.mutate(engine);
  worker.emit(response);
  assert.deepEqual(results, [], `${staleCase.name}: stale hint must not apply`);
  assert.deepEqual(finishes, [{ status: "stale", requestId }]);
  assert.equal(worker.terminateCount, 1);
}

// Surface territory is exact and synchronous today.  This is intentional: a
// legacy worker understands `gridEntries`, while a quotient board only has
// canonical samples.  The controller must cancel an older matrix request and
// never dispatch this topology state into that incompatible protocol.
{
  const engine = createTopologyEngine({ deferTerritoryUpdates: true });
  const move = engine.getSnapshot().legalMoves.at(0)?.vertexId;
  assert.equal(engine.playMove(move).success, true);
  assert.equal(engine.hasPendingTerritoryUpdate(), true);

  let legacyActive = true;
  let cancelCount = 0;
  let startCount = 0;
  const refreshes = [];
  const controller = Object.create(GameController.prototype);
  controller.engine = engine;
  controller._territoryPreview = { stale: true };
  controller._territoryFallbackToken = 7;
  controller._territoryWorkerSession = {
    cancelPending() {
      cancelCount += 1;
      legacyActive = false;
      return true;
    },
    start() {
      startCount += 1;
      throw new Error("topology must not enter the legacy TerritoryWorker");
    },
  };
  controller._syncSnapshot = (snapshot, options) => refreshes.push({ snapshot, options });

  controller._scheduleTerritoryRefresh();

  assert.equal(cancelCount, 1, "a pending legacy matrix request is cancelled");
  assert.equal(legacyActive, false);
  assert.equal(startCount, 0, "the quotient board never enters the legacy worker");
  assert.equal(controller._territoryPreview, null);
  assert.equal(engine.hasPendingTerritoryUpdate(), false,
    "canonical surface territory is calculated before the refreshed snapshot");
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].options.scheduleTerritory, false);
  assert.equal(refreshes[0].snapshot.boardHash, engine.boardHash);
}

console.log(JSON.stringify({
  status: "PASS",
  coverage: [
    "topology hint serializes canonical state and renders canonical vertex IDs",
    "boardHash and revision stale hint responses are rejected",
    "topology territory cancels pending legacy worker work and uses exact canonical calculation",
  ],
  scope: "The current product intentionally performs surface territory synchronously; this does not claim a separate topology TerritoryWorker implementation.",
}));
