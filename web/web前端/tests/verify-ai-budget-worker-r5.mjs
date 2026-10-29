import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { GameEngine } from "../GameEngine.js";
import { serializeEngineState, captureWorkerRequest, isWorkerResultForRequest } from "../AIStateProtocol.js";

const adapter = `const {parentPort,workerData}=require('node:worker_threads');
globalThis.self={postMessage:v=>parentPort.postMessage(v)};
import(workerData).then(()=>parentPort.on('message',data=>self.onmessage({data}))).catch(e=>{throw e})`;
async function run({ gridSize, strategy, depth, budget }) {
  const game = new GameEngine({ gridSize, playerCount: 2, rulesVersion: "territory-v3" });
  const before = game._captureReplayState(), requestId = `${strategy}-${gridSize}`;
  const request = captureWorkerRequest(game, requestId);
  const worker = new Worker(adapter, { eval: true, workerData: new URL("../AIWorker.js", import.meta.url).href });
  let started, initial, latest, readyTimer, loadingTimer;
  try {
    const outcome = await new Promise((resolve, reject) => {
      loadingTimer = setTimeout(() => reject(Error("worker loading timed out")), 10000);
      worker.on("error", reject);
      worker.on("message", message => {
        if (message.type === "READY") {
          assert.ok(isWorkerResultForRequest(game, request, message));
          started = performance.now(); clearTimeout(loadingTimer);
          readyTimer = setTimeout(() => resolve({ type: "deadline", elapsed: performance.now() - started }), budget + 300);
        } else if (message.type === "PROGRESS") {
          assert.ok(isWorkerResultForRequest(game, request, message));
          assert.ok(game._evaluateMove(message.moves[0].point).legal);
          initial ??= message; latest = message;
        } else if (message.type === "RESULT") {
          assert.ok(isWorkerResultForRequest(game, request, message));
          resolve({ type: "result", elapsed: performance.now() - started, message });
        } else if (message.type === "ERROR") reject(Error(message.message));
      });
      worker.postMessage({ type: "COMPUTE", requestId, aiPlayer: game.currentPlayer, strategy,
        serializedState: serializeEngineState(game), topN: 1, depth, timeLimitMs: budget, enableProgress: true });
    });
    assert.ok(initial, "a legal fallback is emitted after READY");
    assert.equal(initial.searchInfo.fallbackReason, "first-legal-action-not-policy");
    if (outcome.type === "deadline") assert.ok(latest, "main thread has a legal action before terminating");
    else {
      const move = outcome.message.moves[0];
      assert.ok(move);
      assert.ok(move.type === "pass" || game._evaluateMove(move.point).legal);
    }
    assert.ok(outcome.elapsed < budget + 1500, "bounded sample completion or termination");
    assert.deepEqual(game._captureReplayState(), before);
    return { strategy, gridSize, ...outcome, message: undefined,
      lastProgress: latest.searchInfo.fallbackReason };
  } finally { clearTimeout(readyTimer); clearTimeout(loadingTimer); await worker.terminate(); }
}
const rows = [await run({ gridSize: 5, strategy: "greedy", depth: 1, budget: 3000 }),
  await run({ gridSize: 15, strategy: "minimax", depth: 4, budget: 3000 })];
assert.equal(rows[0].type, "result");
console.log(JSON.stringify({ status: "PASS", rows,
  scope: "Node Worker, bounded examples; not browser or all-position latency guarantee" }));
