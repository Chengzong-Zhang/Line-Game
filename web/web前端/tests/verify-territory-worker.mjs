import assert from "node:assert/strict";
import {
  GameEngine,
  Player,
  TerritoryRulesVersion,
} from "../GameEngine.js?v=20261025-unified1";
import { serializeEngineState } from "../AIStateProtocol.js?v=20261025-unified1";
import {
  OneShotTerritoryWorker,
  applyTerritoryWorkerResult,
} from "../TerritoryWorkerSession.js?v=20261025-unified1";
import { GameController } from "../GameController.js?v=20261025-unified1";
import { TERRITORY_V2_HOT_PATH_FIXTURES } from "./territory-v2-fixtures.mjs?v=20261025-unified1";

class FakeWorker {
  constructor() {
    this.messages = [];
    this.terminateCount = 0;
    this.onmessage = null;
    this.onerror = null;
  }

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() {
    this.terminateCount += 1;
  }

  emitMessage(data) {
    this.onmessage?.({ data });
  }

  emitError(error) {
    this.onerror?.(error);
  }
}

function createSessionEngine(overrides = {}) {
  return {
    positionRevision: 7,
    rulesVersion: TerritoryRulesVersion.V2,
    currentPlayer: Player.WHITE,
    territoryStateRevision: 11,
    gameOver: false,
    getTerritoryStateRevision() {
      return this.territoryStateRevision;
    },
    ...overrides,
  };
}

function captureSessionFields(engine) {
  return {
    positionRevision: engine.positionRevision,
    rulesVersion: engine.rulesVersion,
    currentPlayer: engine.currentPlayer,
    territoryStateRevision: engine.getTerritoryStateRevision(),
    gameOver: Boolean(engine.gameOver),
  };
}

function createHarness(configureWorker = null) {
  const workers = [];
  const session = new OneShotTerritoryWorker(() => {
    const worker = new FakeWorker();
    configureWorker?.(worker);
    workers.push(worker);
    return worker;
  });
  return { session, workers };
}

function responseFor(worker, fields, overrides = {}) {
  return {
    type: "RESULT",
    requestId: worker.messages[0].requestId,
    positionRevision: fields.positionRevision,
    rulesVersion: fields.rulesVersion,
    currentPlayer: fields.currentPlayer,
    territoryStateRevision: fields.territoryStateRevision,
    gameOver: fields.gameOver,
    territories: {
      [Player.BLACK]: { polygon: null, area: 0, displayArea: 0 },
      [Player.WHITE]: { polygon: null, area: 0, displayArea: 0 },
    },
    ...overrides,
  };
}

function startRequest(harness, engine, currentEngineRef, callbacks = {}) {
  return harness.session.start({
    engine,
    getCurrentEngine: () => currentEngineRef.current,
    message: {
      type: "COMPUTE_TERRITORIES",
      serializedState: {
        positionRevision: engine.positionRevision,
        rulesVersion: engine.rulesVersion,
        currentPlayer: engine.currentPlayer,
      },
    },
    onResult: callbacks.onResult,
    onError: callbacks.onError,
    onFinish: callbacks.onFinish,
  });
}

function playFixture(game, fixture, label) {
  fixture.moves.forEach((point, index) => {
    const result = game.playMove(point);
    assert.equal(
      result.success,
      true,
      `${label}: move ${index + 1} ${JSON.stringify(point)} failed: ${result.reason}`,
    );
  });
}

function createDeferredFixtureGame(fixture) {
  const game = new GameEngine({
    gridSize: fixture.gridSize,
    playerCount: fixture.playerCount,
    rulesVersion: TerritoryRulesVersion.V2,
    deferTerritoryUpdates: true,
  });
  playFixture(game, fixture, fixture.name);
  return game;
}

function areasOf(territories) {
  return Object.fromEntries(
    Object.entries(territories).map(([player, territory]) => [player, territory.area]),
  );
}

function createControllerProbe(engine) {
  const workers = [];
  const renders = [];
  const fallbacks = [];
  const controller = Object.create(GameController.prototype);
  controller.engine = engine;
  controller._territoryFallbackToken = 0;
  controller._territoryWorkerSession = new OneShotTerritoryWorker(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  controller._syncSnapshot = (snapshot, options = {}) => {
    renders.push({ snapshot, options });
  };
  controller._scheduleTerritoryFallback = (target) => {
    fallbacks.push(target);
  };
  return { controller, workers, renders, fallbacks };
}

// Cache application is intentionally delegated to GameEngine, so a result can
// only paint the revision GameEngine accepts.
{
  const calls = [];
  const engine = {
    applyTerritoryCache: (...args) => {
      calls.push(args);
      return true;
    },
  };
  const territories = { [Player.BLACK]: { polygon: null, area: 0, displayArea: 0 } };
  assert.equal(applyTerritoryWorkerResult({
    engine,
    territories,
    territoryStateRevision: 4,
  }), true);
  assert.deepEqual(calls, [[territories, 4]]);
  assert.equal(applyTerritoryWorkerResult({
    engine: null,
    territories,
    territoryStateRevision: 4,
  }), false);
}

// GameController enables deferred territory updates by default only at 15x15
// and keeps an explicit caller override authoritative.
{
  const controller = Object.create(GameController.prototype);
  const small = controller._createEngine({
    gridSize: 9,
    playerCount: 2,
    rulesVersion: TerritoryRulesVersion.V2,
  });
  const large = controller._createEngine({
    gridSize: 15,
    playerCount: 2,
    rulesVersion: TerritoryRulesVersion.V2,
  });
  const explicitlySynchronous = controller._createEngine({
    gridSize: 15,
    playerCount: 2,
    rulesVersion: TerritoryRulesVersion.V2,
    deferTerritoryUpdates: false,
  });
  assert.equal(small.deferTerritoryUpdates, false);
  assert.equal(large.deferTerritoryUpdates, true);
  assert.equal(explicitlySynchronous.deferTerritoryUpdates, false);
}

// Result lifecycle: exactly one callback and one termination, even if the
// worker invokes a retained callback twice after settlement.
{
  const harness = createHarness();
  const engine = createSessionEngine();
  const current = { current: engine };
  const results = [];
  const errors = [];
  const finishes = [];
  const requestId = startRequest(harness, engine, current, {
    onResult: (response) => results.push(response),
    onError: (error) => errors.push(error),
    onFinish: (outcome) => finishes.push(outcome),
  });
  const worker = harness.workers[0];
  const retainedHandler = worker.onmessage;
  const fields = captureSessionFields(engine);

  assert.equal(worker.messages.length, 1);
  assert.equal(worker.messages[0].requestId, requestId);
  assert.equal(worker.messages[0].territoryStateRevision, fields.territoryStateRevision);
  assert.equal(worker.messages[0].gameOver, fields.gameOver);
  assert.equal(harness.session.activeRequestId, requestId);

  retainedHandler({ data: responseFor(worker, fields) });
  retainedHandler({ data: responseFor(worker, fields) });

  assert.equal(results.length, 1);
  assert.equal(errors.length, 0);
  assert.deepEqual(finishes, [{ status: "result", requestId }]);
  assert.equal(worker.terminateCount, 1);
  assert.equal(harness.session.activeRequestId, null);
}

// All guard fields must reject a late response without calling either result
// or error handlers. The source engine is deliberately mutable here so each
// guard can be isolated; GameEngine's rulesVersion itself is immutable.
{
  const staleCases = [
    {
      name: "engine identity",
      mutate: (_engine, current) => { current.current = createSessionEngine(); },
      response: {},
    },
    {
      name: "position revision",
      mutate: (engine) => { engine.positionRevision += 1; },
      response: {},
    },
    {
      name: "rules version",
      mutate: (engine) => { engine.rulesVersion = TerritoryRulesVersion.V1; },
      response: {},
    },
    {
      name: "current player",
      mutate: (engine) => { engine.currentPlayer = Player.BLACK; },
      response: {},
    },
    {
      name: "territory state revision",
      mutate: (engine) => { engine.territoryStateRevision += 1; },
      response: {},
    },
    {
      name: "game over",
      mutate: (engine) => { engine.gameOver = true; },
      response: {},
    },
    {
      name: "worker position echo",
      mutate: () => {},
      response: { positionRevision: 999 },
    },
    {
      name: "worker rules echo",
      mutate: () => {},
      response: { rulesVersion: TerritoryRulesVersion.V1 },
    },
    {
      name: "worker player echo",
      mutate: () => {},
      response: { currentPlayer: Player.BLACK },
    },
    {
      name: "worker territory revision echo",
      mutate: () => {},
      response: { territoryStateRevision: 999 },
    },
    {
      name: "worker game-over echo",
      mutate: () => {},
      response: { gameOver: true },
    },
  ];

  for (const staleCase of staleCases) {
    const harness = createHarness();
    const engine = createSessionEngine();
    const current = { current: engine };
    const fields = captureSessionFields(engine);
    const results = [];
    const errors = [];
    const finishes = [];
    const requestId = startRequest(harness, engine, current, {
      onResult: (response) => results.push(response),
      onError: (error) => errors.push(error),
      onFinish: (outcome) => finishes.push(outcome),
    });
    const worker = harness.workers[0];

    staleCase.mutate(engine, current);
    worker.emitMessage(responseFor(worker, fields, staleCase.response));

    assert.equal(results.length, 0, `${staleCase.name}: stale result applied`);
    assert.equal(errors.length, 0, `${staleCase.name}: stale result reported as an error`);
    assert.deepEqual(
      finishes,
      [{ status: "stale", requestId }],
      `${staleCase.name}: stale outcome`,
    );
    assert.equal(worker.terminateCount, 1, `${staleCase.name}: terminate count`);
    assert.equal(harness.session.activeRequestId, null, `${staleCase.name}: active request leaked`);
  }
}

// Protocol failure, worker failure and a synchronous postMessage failure all
// terminate exactly once and surface an Error to the caller.
for (const errorMode of ["worker-message", "worker-event", "protocol", "request-id", "post-message"]) {
  const harness = createHarness((worker) => {
    if (errorMode === "post-message") {
      worker.postMessage = () => { throw new Error("postMessage failed"); };
    }
  });
  const engine = createSessionEngine();
  const current = { current: engine };
  const fields = captureSessionFields(engine);
  const results = [];
  const errors = [];
  const finishes = [];
  const requestId = startRequest(harness, engine, current, {
    onResult: (response) => results.push(response),
    onError: (error) => errors.push(error),
    onFinish: (outcome) => finishes.push(outcome),
  });
  const worker = harness.workers[0];

  if (errorMode === "worker-message") {
    worker.emitMessage(responseFor(worker, fields, { type: "ERROR", message: "calculation failed" }));
  } else if (errorMode === "worker-event") {
    worker.emitError({ message: "worker crashed" });
  } else if (errorMode === "protocol") {
    worker.emitMessage(responseFor(worker, fields, { type: "UNKNOWN" }));
  } else if (errorMode === "request-id") {
    worker.emitMessage(responseFor(worker, fields, { requestId: requestId + 1 }));
  }

  assert.equal(results.length, 0, `${errorMode}: result must not apply`);
  assert.equal(errors.length, 1, `${errorMode}: error callback count`);
  assert.ok(errors[0] instanceof Error, `${errorMode}: error normalization`);
  assert.deepEqual(finishes, [{ status: "error", requestId }]);
  assert.equal(worker.terminateCount, 1, `${errorMode}: terminate count`);
  assert.equal(harness.session.activeRequestId, null, `${errorMode}: active request leaked`);
}

// Explicit cancellation and a replacement request must isolate retained late
// callbacks from the currently active request.
{
  const harness = createHarness();
  const engine = createSessionEngine();
  const current = { current: engine };
  const firstResults = [];
  const firstFinishes = [];
  const secondResults = [];
  const secondFinishes = [];
  const firstId = startRequest(harness, engine, current, {
    onResult: (response) => firstResults.push(response),
    onFinish: (outcome) => firstFinishes.push(outcome),
  });
  const firstWorker = harness.workers[0];
  const firstHandler = firstWorker.onmessage;
  const firstFields = captureSessionFields(engine);

  assert.equal(harness.session.cancel(), true);
  assert.equal(harness.session.cancel(), false);
  firstHandler({ data: responseFor(firstWorker, firstFields) });
  assert.equal(firstResults.length, 0);
  assert.deepEqual(firstFinishes, [{ status: "cancelled", requestId: firstId }]);
  assert.equal(firstWorker.terminateCount, 1);

  const secondId = startRequest(harness, engine, current, {
    onResult: (response) => secondResults.push(response),
    onFinish: (outcome) => secondFinishes.push(outcome),
  });
  const secondWorker = harness.workers[1];
  const secondFields = captureSessionFields(engine);
  const secondHandler = secondWorker.onmessage;

  firstHandler({ data: responseFor(firstWorker, firstFields) });
  assert.equal(harness.session.activeRequestId, secondId);
  secondHandler({ data: responseFor(secondWorker, secondFields) });
  assert.equal(firstResults.length, 0);
  assert.equal(secondResults.length, 1);
  assert.deepEqual(secondFinishes, [{ status: "result", requestId: secondId }]);
  assert.equal(secondWorker.terminateCount, 1);
}

// Starting a new request also cancels the old one, even if callers did not
// explicitly invoke cancel between board updates.
{
  const harness = createHarness();
  const engine = createSessionEngine();
  const current = { current: engine };
  const firstFinishes = [];
  const secondResults = [];
  const secondFinishes = [];
  const firstId = startRequest(harness, engine, current, {
    onFinish: (outcome) => firstFinishes.push(outcome),
  });
  const firstWorker = harness.workers[0];
  const firstHandler = firstWorker.onmessage;
  const firstFields = captureSessionFields(engine);
  const secondId = startRequest(harness, engine, current, {
    onResult: (response) => secondResults.push(response),
    onFinish: (outcome) => secondFinishes.push(outcome),
  });
  const secondWorker = harness.workers[1];
  const secondFields = captureSessionFields(engine);

  assert.equal(firstWorker.terminateCount, 1);
  assert.deepEqual(firstFinishes, [{ status: "cancelled", requestId: firstId }]);
  firstHandler({ data: responseFor(firstWorker, firstFields) });
  assert.equal(harness.session.activeRequestId, secondId);
  secondWorker.emitMessage(responseFor(secondWorker, secondFields));
  assert.equal(secondResults.length, 1);
  assert.deepEqual(secondFinishes, [{ status: "result", requestId: secondId }]);
  assert.equal(secondWorker.terminateCount, 1);
}

// Controller integration: a current worker result writes the revision-checked
// cache and publishes the exact render snapshot, while a response stale by the next board
// position has no rendering or scoring side effect.
{
  const fixture = TERRITORY_V2_HOT_PATH_FIXTURES.find(
    (candidate) => candidate.gridSize === 15 && candidate.playerCount === 2,
  );
  assert.ok(fixture, "missing 15x15 two-player controller fixture");
  const source = createDeferredFixtureGame(fixture);
  const reference = createDeferredFixtureGame(fixture);
  reference._updateTerritories();
  const territories = reference.getScoreboard();
  const { controller, workers, renders, fallbacks } = createControllerProbe(source);

  GameController.prototype._scheduleTerritoryRefresh.call(controller);
  assert.equal(workers.length, 1, "pending 15x15 board starts one worker");
  assert.equal(source.hasPendingTerritoryUpdate(), true, "dispatch itself must not settle on the main engine");
  assert.equal(source.getSnapshot().territoryPending, true, "pending cache is visible to the renderer and score UI");
  const worker = workers[0];
  const fields = captureSessionFields(source);
  worker.emitMessage(responseFor(worker, fields, { territories }));

  assert.equal(source.hasPendingTerritoryUpdate(), false, "current worker result settles the cache");
  assert.deepEqual(source.getScoreboard(), territories, "controller applies exact worker territories");
  assert.equal(renders.length, 1, "current worker result rerenders once");
  assert.equal(renders[0].snapshot.territoryPending, false, "accepted result clears the renderer pending state");
  assert.deepEqual(renders[0].snapshot.territories, territories, "renderer receives the complete exact result");
  assert.equal(renders[0].options.scheduleTerritory, false, "accepted result does not start a duplicate worker");
  assert.deepEqual(fallbacks, [], "successful worker result needs no fallback");

  const staleSource = createDeferredFixtureGame(fixture);
  const staleReference = createDeferredFixtureGame(fixture);
  staleReference._updateTerritories();
  const staleHarness = createControllerProbe(staleSource);
  GameController.prototype._scheduleTerritoryRefresh.call(staleHarness.controller);
  const staleWorker = staleHarness.workers[0];
  const staleFields = captureSessionFields(staleSource);
  const nextMove = staleSource.getLegalMoves()[0]?.point;
  assert.ok(nextMove, "fixture needs a legal next move for stale-result coverage");
  assert.equal(staleSource.playMove(nextMove).success, true, "advance source before old response");
  staleWorker.emitMessage(responseFor(staleWorker, staleFields, {
    territories: staleReference.getScoreboard(),
  }));
  assert.equal(staleSource.hasPendingTerritoryUpdate(), true, "old worker cannot settle the new board");
  assert.deepEqual(staleHarness.renders, [], "old worker cannot force a stale render");
  assert.deepEqual(staleHarness.fallbacks, [], "a stale result is not a worker failure");
}

// Run the actual Worker module with Node's minimal `self` shim. This is not a
// browser Worker-thread test, but it does execute the production serializer
// restore path and the exact territory computation without a browser.
const previousSelf = globalThis.self;
const workerMessages = [];
const workerSelf = {
  postMessage(message) {
    workerMessages.push(message);
  },
};
globalThis.self = workerSelf;
try {
  const workerUrl = new URL(
    `../TerritoryWorker.js?verify-territory-worker=${Date.now()}`,
    import.meta.url,
  );
  await import(workerUrl.href);
  assert.equal(typeof workerSelf.onmessage, "function");

  const fifteenFixtures = TERRITORY_V2_HOT_PATH_FIXTURES.filter(
    (fixture) => fixture.gridSize === 15 && (fixture.playerCount === 2 || fixture.playerCount === 3),
  );
  assert.deepEqual(fifteenFixtures.map((fixture) => fixture.playerCount).sort(), [2, 3]);

  for (const fixture of fifteenFixtures) {
    const source = createDeferredFixtureGame(fixture);
    assert.equal(source.hasPendingTerritoryUpdate(), true, `${fixture.name}: expected deferred cache`);
    const serializedState = serializeEngineState(source);
    const territoryStateRevision = source.getTerritoryStateRevision();
    const expectedResponseFields = {
      positionRevision: source.positionRevision,
      rulesVersion: source.rulesVersion,
      currentPlayer: source.currentPlayer,
      territoryStateRevision,
      gameOver: source.gameOver,
    };

    source._updateTerritories();
    const synchronousTerritories = source.getScoreboard();
    assert.equal(source.hasPendingTerritoryUpdate(), false, `${fixture.name}: sync reference cache`);
    assert.deepEqual(areasOf(synchronousTerritories), fixture.expectedAreas, `${fixture.name}: fixture reference areas`);

    const messageStart = workerMessages.length;
    const requestId = `parity-${fixture.name}`;
    workerSelf.onmessage({
      data: {
        type: "COMPUTE_TERRITORIES",
        requestId,
        serializedState,
        territoryStateRevision,
        gameOver: source.gameOver,
      },
    });
    assert.equal(workerMessages.length, messageStart + 1, `${fixture.name}: worker response count`);
    const response = workerMessages.at(-1);
    assert.equal(response.type, "RESULT", `${fixture.name}: worker status`);
    assert.equal(response.requestId, requestId, `${fixture.name}: worker request id`);
    for (const [key, value] of Object.entries(expectedResponseFields)) {
      assert.equal(response[key], value, `${fixture.name}: worker ${key} echo`);
    }
    assert.deepEqual(response.territories, synchronousTerritories, `${fixture.name}: worker/sync parity`);

    const cacheTarget = createDeferredFixtureGame(fixture);
    assert.equal(cacheTarget.getTerritoryStateRevision(), territoryStateRevision, `${fixture.name}: target revision`);
    assert.equal(
      applyTerritoryWorkerResult({
        engine: cacheTarget,
        territories: response.territories,
        territoryStateRevision: response.territoryStateRevision,
      }),
      true,
      `${fixture.name}: worker cache accepted`,
    );
    assert.equal(cacheTarget.hasPendingTerritoryUpdate(), false, `${fixture.name}: accepted cache becomes current`);
    assert.deepEqual(cacheTarget.getScoreboard(), synchronousTerritories, `${fixture.name}: applied cache parity`);
    assert.equal(
      applyTerritoryWorkerResult({
        engine: cacheTarget,
        territories: response.territories,
        territoryStateRevision: response.territoryStateRevision + 1,
      }),
      false,
      `${fixture.name}: later revision is rejected`,
    );
    assert.deepEqual(cacheTarget.getScoreboard(), synchronousTerritories, `${fixture.name}: rejected cache cannot paint`);
  }

  workerSelf.onmessage({
    data: {
      type: "COMPUTE_TERRITORIES",
      requestId: "invalid-payload",
      serializedState: null,
      territoryStateRevision: 0,
      gameOver: false,
    },
  });
  assert.equal(workerMessages.at(-1).type, "ERROR");
  assert.equal(workerMessages.at(-1).requestId, "invalid-payload");
  assert.match(workerMessages.at(-1).message, /invalid state payload/);
} finally {
  globalThis.self = previousSelf;
}

// Terminal snapshots must use the fresh territory cache that winner
// calculation settles. Both end paths start from the same deferred 15x15
// board, whose cached score is deliberately stale before the terminal action.
const twoPlayerFifteenFixture = TERRITORY_V2_HOT_PATH_FIXTURES.find(
  (fixture) => fixture.gridSize === 15 && fixture.playerCount === 2,
);
assert.ok(twoPlayerFifteenFixture, "missing 15x15 two-player fixture");
for (const terminalAction of ["skip", "resign"]) {
  const game = createDeferredFixtureGame(twoPlayerFifteenFixture);
  const reference = createDeferredFixtureGame(twoPlayerFifteenFixture);
  reference._updateTerritories();
  const referenceTerritories = reference.getScoreboard();
  assert.equal(game.hasPendingTerritoryUpdate(), true, `${terminalAction}: setup must have stale cache`);

  let terminalResult;
  if (terminalAction === "skip") {
    assert.equal(game.skipTurn().success, true, "skip: first skip");
    terminalResult = game.skipTurn();
  } else {
    terminalResult = game.resignPlayer(game.currentPlayer);
  }

  assert.equal(terminalResult.success, true, `${terminalAction}: terminal action`);
  assert.equal(game.gameOver, true, `${terminalAction}: expected terminal game`);
  assert.ok(terminalResult.snapshot, `${terminalAction}: terminal snapshot`);
  const settledTerritories = game.getScoreboard();
  assert.equal(game.hasPendingTerritoryUpdate(), false, `${terminalAction}: winner must settle cache`);
  assert.deepEqual(
    settledTerritories,
    referenceTerritories,
    `${terminalAction}: terminal cache must equal an independently synchronized reference`,
  );
  assert.deepEqual(
    terminalResult.snapshot.territories,
    referenceTerritories,
    `${terminalAction}: snapshot territories must not predate winner settlement`,
  );
  assert.equal(
    terminalResult.snapshot.winner,
    game.getWinner(),
    `${terminalAction}: snapshot winner/cache agreement`,
  );
}

console.log(JSON.stringify({
  oneShotTerritoryWorker: true,
  requestGuardFields: [
    "requestId",
    "engineIdentity",
    "positionRevision",
    "rulesVersion",
    "currentPlayer",
    "territoryStateRevision",
    "gameOver",
    "workerEchoes",
  ],
  terminalPaths: [
    "result",
    "stale",
    "cancelled",
    "worker-error",
    "worker-message-error",
    "post-message-error",
    "protocol-error",
    "duplicate-terminal-ignored",
  ],
  parityFixtures: ["two-player-15-midgame", "three-player-15-midgame"],
  controllerIntegration: [
    "15x15-default-deferred",
    "accepted-result-exact-snapshot",
    "stale-result-no-render",
  ],
  terminalSnapshotRegression: ["skip", "resign"],
  executionBoundary: "actual Worker module under a Node self shim; no browser Worker-thread or canvas timing coverage",
}, null, 2));
