// Proves the emitted Hard Worker contains the current V3 scoring source and
// accepts a territory-v3 request through the production worker route.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import GameEngine from "../GameEngine.js?v=20261025-room1";
import { serializeEngineState } from "../AIStateProtocol.js?v=20261025-room1";
import { createLocalAIWorker, localAIWorkerRoute } from "../LocalAIWorkerFactory.js?v=20261025-room1";

const [buildName, receiptName] = process.argv.slice(2);
assert(buildName && receiptName, "Expected a fresh build directory and receipt path");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const build = resolve(buildName);
const buildReceipt = JSON.parse(await readFile(resolve(build, "build-receipt.json")));
const { integrity, ...buildBody } = buildReceipt;
assert.equal(integrity, sha(JSON.stringify(buildBody)));
assert.equal(buildReceipt.status, "BUILT_NOT_VERIFIED");

const frontend = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = resolve(frontend, "MultiplayerHardAIWorker.bundle.manifest.json");
const manifest = JSON.parse(await readFile(manifestPath));
const engineBytes = await readFile(new URL("../GameEngine.js?v=20261025-room1", import.meta.url));
assert.equal(manifest.sourceHashes["GameEngine.js"], sha(engineBytes),
  "emitted bundle must embed the exact current GameEngine source");
assert.equal(buildReceipt.manifest.sourceHashes["GameEngine.js"], sha(engineBytes));
assert.equal(sha(await readFile(buildReceipt.output.path)), manifest.bundleSha256);

const context = { rulesVersion: "territory-v3", playerCount: 4, gridSize: 5, boardShape: "hexagon" };
const profile = { strategy: "multiplayer", modelId: "multiplayer-hard-v1" };
const route = localAIWorkerRoute(context, [profile]);
assert.equal(route.kind, "native-hard-bundle");
assert.equal(route.url.searchParams.get("v"), "20261025-room1");
assert.equal(route.url.pathname, pathToFileURL(buildReceipt.output.path).pathname);

class CapturedWorker {
  constructor(url, options) { this.url = new URL(url); this.options = options; }
}
const captured = createLocalAIWorker(context, [profile], CapturedWorker);
assert.equal(captured.url.href, route.url.href);
assert.deepEqual(captured.options, { type: "module" });

const originalFetch = globalThis.fetch;
const originalSelf = globalThis.self;
const listeners = [];
const messages = [];
let settle;
const result = new Promise((resolveResult, rejectResult) => {
  const timeout = setTimeout(() => rejectResult(new Error("V3 Hard Worker request timed out")), 10000);
  settle = message => { clearTimeout(timeout); resolveResult(message); };
});
globalThis.fetch = async input => {
  const url = new URL(input);
  assert.equal(url.protocol, "file:");
  return new Response(await readFile(fileURLToPath(url)), { status: 200 });
};
globalThis.self = {
  location: { href: pathToFileURL(buildReceipt.output.path).href },
  onmessage: null,
  postMessage(message) {
    messages.push(message);
    if (["RESULT", "ERROR"].includes(message.type) && message.requestId === "territory-v3-hard-worker") {
      settle(message);
    }
  },
  addEventListener(type, listener) {
    assert.equal(type, "message");
    listeners.push(listener);
  },
};
try {
  await import(pathToFileURL(buildReceipt.output.path));
  assert.equal(listeners.length, 1);
  const engine = new GameEngine(context);
  const state = serializeEngineState(engine);
  assert.equal(state.rulesVersion, "territory-v3");
  listeners[0]({
    data: {
      type: "COMPUTE",
      requestId: "territory-v3-hard-worker",
      ...profile,
      serializedState: state,
      aiPlayer: state.currentPlayer,
      topN: 1,
    },
    stopImmediatePropagation() {},
  });
  const reply = await result;
  assert.equal(reply.type, "RESULT", reply.message);
  assert.equal(reply.rulesVersion, "territory-v3");
  assert.equal(reply.currentPlayer, state.currentPlayer);
  assert.equal(reply.positionRevision, state.positionRevision);
  assert.equal(reply.modelInfo.id, profile.modelId);
  assert.equal(reply.modelInfo.terminalEvaluation, "native-territory-v3");
  assert.equal(reply.moves.length, 1);

  const receipt = {
    schema: "lifeline-territory-v3-hard-worker-verification-v1",
    status: "PASS_V3_HARD_WORKER_SOURCE_AND_ROUTE",
    bundleSha256: manifest.bundleSha256,
    currentGameEngineSha256: sha(engineBytes),
    route: { kind: route.kind, url: route.url.href },
    request: { rulesVersion: state.rulesVersion, playerCount: context.playerCount,
      gridSize: context.gridSize, replyType: reply.type, returnedMoves: reply.moves.length,
      terminalEvaluation: reply.modelInfo.terminalEvaluation },
    checks: ["manifest GameEngine hash equals current source", "captured production route targets emitted bundle",
      "actual emitted Worker listener returns a V3 Hard result"],
    limits: ["Controlled Node Worker shim with file-backed assets; no browser timing or playing-strength claim.",
      "Current-score parity is established by the separate main-thread scoring fixture; this worker request verifies source identity and V3 route execution."]
  };
  await writeFile(resolve(receiptName), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ status: receipt.status, bundleSha256: receipt.bundleSha256,
    gameEngineSha256: receipt.currentGameEngineSha256, route: route.kind }));
} finally {
  globalThis.fetch = originalFetch;
  if (originalSelf === undefined) delete globalThis.self; else globalThis.self = originalSelf;
}
