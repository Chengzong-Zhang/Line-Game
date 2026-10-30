import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GameEngine } from "../GameEngine.js";
import { localAIWorkerRoute } from "../LocalAIWorkerFactory.js";
import { isolatedSearchEngine } from "../MultiplayerSearch.js";
import { serializeEngineState, captureWorkerRequest, isWorkerResultForRequest } from "../AIStateProtocol.js";

// Exercise the emitted bundle's entry, not the source Worker. File-backed
// fetch emulates app assets; this is not a browser scheduling measurement.
const bundleUrl = new URL("../MultiplayerHardWorkerEntry.js", import.meta.url);
const originalFetch = globalThis.fetch, originalSelf = globalThis.self, listeners = [], messages = [];
let resolveFinal;
const final = new Promise(resolve => { resolveFinal = resolve; });
globalThis.fetch = async input => {
  const url = new URL(input);
  assert.equal(url.protocol, "file:");
  return new Response(await readFile(fileURLToPath(url)), { status: 200 });
};
globalThis.self = { location: { href: bundleUrl.href }, onmessage: null,
  addEventListener(type, listener) { assert.equal(type, "message"); listeners.push(listener); },
  postMessage(message) { messages.push(message); if (["RESULT", "ERROR"].includes(message.type)) resolveFinal(message); },
};
try {
  await import(pathToFileURL(fileURLToPath(bundleUrl)).href + "?progress-test=" + Date.now());
  const order = ["PURPLE", "BLACK", "GREEN", "WHITE"];
  const game = new GameEngine({ playerCount: 4, gridSize: 5, rulesVersion: "territory-v3", startPlayer: order[0], turnOrder: order });
  const profiles = [{strategy: "multiplayer", modelId: "multiplayer-hard-v1"}];
  assert.equal(localAIWorkerRoute(game, profiles).kind, "native-hard-source-turn-order");
  assert.equal(localAIWorkerRoute(new GameEngine({ playerCount: 4, gridSize: 5, rulesVersion: "territory-v3" }), profiles).kind, "native-hard-bundle");
  const isolated = isolatedSearchEngine(game); assert.deepEqual(isolated.turnOrder, order);
  assert.equal(isolated._getNextPlayer("PURPLE"), "BLACK");
  const before = game._captureReplayState(), requestId = "hard-progress-r5";
  const request = captureWorkerRequest(game, requestId);
  listeners[0]({ data: { type: "COMPUTE", strategy: "multiplayer", modelId: "multiplayer-hard-v1",
    requestId, serializedState: serializeEngineState(game), aiPlayer: game.currentPlayer,
    topN: 2, enableProgress: true, timeLimitMs: 3000 }, stopImmediatePropagation() {} });
  let timer;
  const result = await Promise.race([final, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error("bundle request timed out")), 10000);
  })]);
  clearTimeout(timer);
  assert.equal(result.type, "RESULT", result.message);
  assert.equal(messages.find(message => message.requestId === requestId)?.type, "READY");
  const progress = messages.filter(message => message.type === "PROGRESS");
  assert.ok(progress.length > 0);

  for (const item of progress) {
    assert.ok(isWorkerResultForRequest(game, request, item));
    assert.equal(game._evaluateMove(item.moves[0].point).legal, true);
  }
  assert.ok(isWorkerResultForRequest(game, request, result));
  const move = result.moves[0];
  assert.ok(move?.type === "pass" || game._evaluateMove(move.point).legal);
  assert.deepEqual(game._captureReplayState(), before);
  console.log(JSON.stringify({ status: "PASS", progressMessages: progress.length,
    latestProgress: progress.at(-1).searchInfo.fallbackReason,
    implementationId: result.modelInfo.implementationId,
    scope: "ordered source hard Worker entry, file-backed assets and controlled messaging; not browser or strength acceptance" }));
} finally { globalThis.fetch = originalFetch; if (originalSelf === undefined) delete globalThis.self; else globalThis.self = originalSelf; }
