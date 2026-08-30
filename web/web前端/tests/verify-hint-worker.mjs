import assert from "node:assert/strict";
import {
  OneShotHintWorker,
  applyHintWorkerResult,
} from "../HintWorkerSession.js?v=20260830a";

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

function createEngine(overrides = {}) {
  return {
    positionRevision: 7,
    rulesVersion: "territory-v2",
    currentPlayer: "WHITE",
    ...overrides,
  };
}

function createHarness(configureWorker = null) {
  const workers = [];
  const session = new OneShotHintWorker(() => {
    const worker = new FakeWorker();
    configureWorker?.(worker);
    workers.push(worker);
    return worker;
  });
  return { session, workers };
}

function responseFor(worker, engine, overrides = {}) {
  return {
    type: "RESULT",
    requestId: worker.messages[0].requestId,
    positionRevision: engine.positionRevision,
    rulesVersion: engine.rulesVersion,
    currentPlayer: engine.currentPlayer,
    moves: [{ point: [1, 2], score: 10 }],
    ...overrides,
  };
}

function startRequest(harness, engine, currentEngineRef, callbacks = {}) {
  return harness.session.start({
    engine,
    getCurrentEngine: () => currentEngineRef.current,
    message: {
      type: "COMPUTE",
      serializedState: {
        positionRevision: engine.positionRevision,
        rulesVersion: engine.rulesVersion,
        currentPlayer: engine.currentPlayer,
      },
      aiPlayer: engine.currentPlayer,
      depth: 2,
      topN: 1,
    },
    onResult: callbacks.onResult,
    onError: callbacks.onError,
    onFinish: callbacks.onFinish,
  });
}

{
  const rendered = [];
  const applied = applyHintWorkerResult({
    moves: [{ point: [1, 2], score: 10 }],
    legalMoves: [{ point: [1, 2] }, { point: [2, 2] }],
    remainingCount: 3,
    renderHint: (point) => rendered.push(point),
  });
  assert.deepEqual(applied, {
    applied: true,
    reason: null,
    point: [1, 2],
    nextRemainingCount: 2,
  });
  assert.deepEqual(rendered, [[1, 2]]);

  for (const candidate of [
    { moves: [], legalMoves: [{ point: [1, 2] }], remainingCount: 3, reason: "NO_MOVE" },
    { moves: [{ point: [4, 4] }], legalMoves: [{ point: [1, 2] }], remainingCount: 3, reason: "ILLEGAL_MOVE" },
    { moves: [{ point: [1, 2] }], legalMoves: [{ point: [1, 2] }], remainingCount: 0, reason: "EXHAUSTED" },
  ]) {
    let renderCount = 0;
    const rejected = applyHintWorkerResult({
      moves: candidate.moves,
      legalMoves: candidate.legalMoves,
      remainingCount: candidate.remainingCount,
      renderHint: () => { renderCount += 1; },
    });
    assert.equal(rejected.applied, false);
    assert.equal(rejected.reason, candidate.reason);
    assert.equal(rejected.nextRemainingCount, candidate.remainingCount);
    assert.equal(renderCount, 0);
  }

  assert.throws(
    () => applyHintWorkerResult({
      moves: [{ point: [1, 2] }],
      legalMoves: [{ point: [1, 2] }],
      remainingCount: 3,
      renderHint: () => { throw new Error("render failed"); },
    }),
    /render failed/,
  );
}

{
  const harness = createHarness();
  const engine = createEngine();
  const current = { current: engine };
  const results = [];
  const errors = [];
  const finishes = [];
  const requestId = startRequest(harness, engine, current, {
    onResult: (message) => results.push(message),
    onError: (error) => errors.push(error),
    onFinish: (outcome) => finishes.push(outcome),
  });
  const worker = harness.workers[0];

  assert.equal(worker.messages.length, 1);
  assert.equal(worker.messages[0].requestId, requestId);
  assert.equal(harness.session.activeRequestId, requestId);
  const terminalHandler = worker.onmessage;
  const terminalResponse = responseFor(worker, engine);
  terminalHandler({ data: terminalResponse });
  terminalHandler({ data: terminalResponse });

  assert.equal(results.length, 1);
  assert.equal(errors.length, 0);
  assert.deepEqual(finishes, [{ status: "result", requestId }]);
  assert.equal(worker.terminateCount, 1);
  assert.equal(harness.session.activeRequestId, null);
}

{
  const harness = createHarness();
  const engine = createEngine();
  const current = { current: engine };
  const rendered = [];
  const finishes = [];
  let remainingCount = 3;
  const requestId = startRequest(harness, engine, current, {
    onResult: (message) => {
      const application = applyHintWorkerResult({
        moves: message.moves,
        legalMoves: [{ point: [1, 2] }],
        remainingCount,
        renderHint: (point) => rendered.push(point),
      });
      remainingCount = application.nextRemainingCount;
    },
    onFinish: (outcome) => finishes.push(outcome),
  });
  const worker = harness.workers[0];
  worker.emitMessage(responseFor(worker, engine, { moves: [] }));

  assert.equal(remainingCount, 3);
  assert.deepEqual(rendered, []);
  assert.deepEqual(finishes, [{ status: "result", requestId }]);
  assert.equal(worker.terminateCount, 1);
  assert.equal(harness.session.activeRequestId, null);
}

for (const errorMode of ["message", "event", "protocol"]) {
  const harness = createHarness();
  const engine = createEngine();
  const current = { current: engine };
  const results = [];
  const errors = [];
  const finishes = [];
  const requestId = startRequest(harness, engine, current, {
    onResult: (message) => results.push(message),
    onError: (error) => errors.push(error),
    onFinish: (outcome) => finishes.push(outcome),
  });
  const worker = harness.workers[0];

  if (errorMode === "message") {
    worker.emitMessage(responseFor(worker, engine, {
      type: "ERROR",
      moves: undefined,
      message: "search failed",
    }));
  } else if (errorMode === "event") {
    worker.emitError(new Error("worker crashed"));
  } else {
    worker.emitMessage(responseFor(worker, engine, { type: "UNKNOWN" }));
  }

  assert.equal(results.length, 0, `${errorMode}: result must not apply`);
  assert.equal(errors.length, 1, `${errorMode}: error callback count`);
  assert.deepEqual(finishes, [{ status: "error", requestId }]);
  assert.equal(worker.terminateCount, 1);
}

{
  const harness = createHarness((worker) => {
    worker.postMessage = () => { throw new Error("postMessage failed"); };
  });
  const engine = createEngine();
  const current = { current: engine };
  const errors = [];
  const finishes = [];
  const requestId = startRequest(harness, engine, current, {
    onError: (error) => errors.push(error),
    onFinish: (outcome) => finishes.push(outcome),
  });
  const worker = harness.workers[0];

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /postMessage failed/);
  assert.deepEqual(finishes, [{ status: "error", requestId }]);
  assert.equal(worker.terminateCount, 1);
  assert.equal(harness.session.activeRequestId, null);
}

{
  const harness = createHarness();
  const engine = createEngine();
  const current = { current: engine };
  const results = [];
  const finishes = [];
  const requestId = startRequest(harness, engine, current, {
    onResult: (message) => results.push(message),
    onFinish: (outcome) => finishes.push(outcome),
  });
  const worker = harness.workers[0];
  const lateHandler = worker.onmessage;
  const lateResponse = responseFor(worker, engine);

  assert.equal(harness.session.cancel(), true);
  assert.equal(harness.session.cancel(), false);
  lateHandler({ data: lateResponse });

  assert.equal(results.length, 0);
  assert.deepEqual(finishes, [{ status: "cancelled", requestId }]);
  assert.equal(worker.terminateCount, 1);
}

{
  const staleCases = [
    {
      name: "engine identity",
      mutate: (_engine, current) => { current.current = createEngine(); },
      response: {},
    },
    {
      name: "position revision",
      mutate: (engine) => { engine.positionRevision += 1; },
      response: {},
    },
    {
      name: "rules version",
      mutate: (engine) => { engine.rulesVersion = "territory-v1"; },
      response: {},
    },
    {
      name: "current player",
      mutate: (engine) => { engine.currentPlayer = "BLACK"; },
      response: {},
    },
    {
      name: "worker revision echo",
      mutate: () => {},
      response: { positionRevision: 999 },
    },
    {
      name: "worker rules echo",
      mutate: () => {},
      response: { rulesVersion: "territory-v1" },
    },
    {
      name: "worker player echo",
      mutate: () => {},
      response: { currentPlayer: "BLACK" },
    },
  ];

  for (const staleCase of staleCases) {
    const harness = createHarness();
    const engine = createEngine();
    const responseEngine = { ...engine };
    const current = { current: engine };
    const results = [];
    const finishes = [];
    const requestId = startRequest(harness, engine, current, {
      onResult: (message) => results.push(message),
      onFinish: (outcome) => finishes.push(outcome),
    });
    const worker = harness.workers[0];
    staleCase.mutate(engine, current);
    worker.emitMessage(responseFor(worker, responseEngine, staleCase.response));

    assert.equal(results.length, 0, `${staleCase.name}: stale result applied`);
    assert.deepEqual(
      finishes,
      [{ status: "stale", requestId }],
      `${staleCase.name}: stale outcome`,
    );
    assert.equal(worker.terminateCount, 1, `${staleCase.name}: terminate count`);
  }
}

{
  const harness = createHarness();
  const engine = createEngine();
  const current = { current: engine };
  const results = [];
  const errors = [];
  const finishes = [];
  const requestId = startRequest(harness, engine, current, {
    onResult: (message) => results.push(message),
    onError: (error) => errors.push(error),
    onFinish: (outcome) => finishes.push(outcome),
  });
  const worker = harness.workers[0];
  worker.emitMessage(responseFor(worker, engine, { requestId: requestId + 1 }));

  assert.equal(results.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /mismatched requestId/);
  assert.deepEqual(finishes, [{ status: "error", requestId }]);
  assert.equal(worker.terminateCount, 1);
  assert.equal(harness.session.activeRequestId, null);
}

{
  const harness = createHarness();
  const engine = createEngine();
  const current = { current: engine };
  const firstResults = [];
  const firstFinishes = [];
  const secondResults = [];
  const secondFinishes = [];
  const firstId = startRequest(harness, engine, current, {
    onResult: (message) => firstResults.push(message),
    onFinish: (outcome) => firstFinishes.push(outcome),
  });
  const firstWorker = harness.workers[0];
  const lateFirstHandler = firstWorker.onmessage;
  const lateFirstResponse = responseFor(firstWorker, engine);

  const secondId = startRequest(harness, engine, current, {
    onResult: (message) => secondResults.push(message),
    onFinish: (outcome) => secondFinishes.push(outcome),
  });
  const secondWorker = harness.workers[1];

  assert.notEqual(firstWorker, secondWorker);
  assert.equal(firstWorker.terminateCount, 1);
  assert.deepEqual(firstFinishes, [{ status: "cancelled", requestId: firstId }]);
  lateFirstHandler({ data: lateFirstResponse });
  assert.equal(harness.session.activeRequestId, secondId);
  assert.equal(secondFinishes.length, 0);

  secondWorker.emitMessage(responseFor(secondWorker, engine));
  assert.equal(firstResults.length, 0);
  assert.equal(secondResults.length, 1);
  assert.deepEqual(secondFinishes, [{ status: "result", requestId: secondId }]);
  assert.equal(secondWorker.terminateCount, 1);
}

console.log(JSON.stringify({
  oneShotWorkerLifecycle: true,
  requestGuardFields: [
    "requestId",
    "engineIdentity",
    "positionRevision",
    "rulesVersion",
    "currentPlayer",
  ],
  terminalPaths: [
    "result",
    "empty",
    "error",
    "worker-error",
    "post-message-error",
    "invalid-protocol",
    "stale",
    "cancelled",
  ],
  duplicateTerminalIgnored: true,
  lateResultIsolation: true,
}, null, 2));
