import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { GameEngine } from "../GameEngine.js";
import { localAIWorkerRoute } from "../LocalAIWorkerFactory.js";
import { serializeEngineState, captureWorkerRequest, isWorkerResultForRequest } from "../AIStateProtocol.js";

// File-backed emulation validates the actual frozen entry and its model paths;
// it is not a browser timing or model strength assessment.
const playerCount = Number(process.argv[2] || 4);
assert.ok([3, 4].includes(playerCount));
const game = new GameEngine({ playerCount, gridSize: 5, rulesVersion: "territory-v3" });
const route = localAIWorkerRoute(game, [{ strategy: "multiplayer", modelId: "multiplayer-hard-v1" }]);
assert.equal(route.kind, "native-hard-bundle");
assert.match(route.url.pathname, /\/frozen-workers\/web-topology-fix-20261030-r2\/MultiplayerHardAIWorker\.bundle\.mjs$/);
const savedFetch = globalThis.fetch, savedSelf = globalThis.self, messages = [], listeners = [];
let done;
const final = new Promise(resolve => { done = resolve; });
globalThis.fetch = async input => {
  const url = new URL(input);
  assert.equal(url.protocol, "file:");
  return new Response(await readFile(fileURLToPath(url)), { status: 200 });
};
globalThis.self = { location: { href: route.url.href }, onmessage: null,
  addEventListener(type, listener) { assert.equal(type, "message"); listeners.push(listener); },
  postMessage(message) { messages.push(message); if (["RESULT", "ERROR"].includes(message.type)) done(message); },
};
try {
  await import(route.url.href);
  const before = game._captureReplayState(), requestId = `frozen-hard-${playerCount}`;
  const request = captureWorkerRequest(game, requestId);
  listeners[0]({ data: { type: "COMPUTE", strategy: "multiplayer", modelId: "multiplayer-hard-v1", requestId,
    serializedState: serializeEngineState(game), aiPlayer: game.currentPlayer, topN: 2,
    enableProgress: true, timeLimitMs: 3000 }, stopImmediatePropagation() {} });
  let timer;
  const result = await Promise.race([final, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error("frozen Worker request timed out")), 10000);
  })]);
  clearTimeout(timer);
  assert.equal(result.type, "RESULT", result.message);
  assert.equal(messages.find(m => m.requestId === requestId)?.type, "READY");
  assert.ok(messages.some(m => m.type === "PROGRESS"));
  assert.ok(isWorkerResultForRequest(game, request, result));
  const move = result.moves[0];
  assert.ok(move?.type === "pass" || game._evaluateMove(move.point).legal);
  assert.deepEqual(game._captureReplayState(), before);
  console.log(JSON.stringify({ status: "PASS", playerCount, entry: route.url.pathname,
    implementationId: result.modelInfo.implementationId, scope: "file-backed frozen Worker; not browser or strength acceptance" }));
} finally {
  globalThis.fetch = savedFetch;
  if (savedSelf === undefined) delete globalThis.self; else globalThis.self = savedSelf;
}
