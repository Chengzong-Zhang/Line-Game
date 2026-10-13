import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import GameEngine from "../GameEngine.js?v=20260910d";
import { serializeEngineState } from "../AIStateProtocol.js?v=20260830a";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;
const oldFetch = globalThis.fetch;
globalThis.fetch = async (url) => new Response(await readFile(url));
const messages = [];
globalThis.self = { postMessage: (m) => messages.push(m) };
await import("../AIWorker.js?v=20261012a");
const manifest = JSON.parse(await readFile(new URL("../assets/research-ai/transfer-v1/manifest.json", import.meta.url), "utf8"));
const engine = new GameEngine({ gridSize: 6, startPlayer: "WHITE", rulesVersion: "territory-v2" });
engine.playMove(engine.getLegalMoves(engine.currentPlayer)[0].point);
const serializedState = serializeEngineState(engine);
const before = JSON.stringify(serializedState);
try {
  for (const [i, spec] of manifest.models.entries()) {
    await self.onmessage({ data: { type: "COMPUTE", serializedState, aiPlayer: engine.currentPlayer,
      strategy: "neural-puct", modelId: spec.id, simulations: 2, cPuct: 1.5, topN: 1000, requestId: i + 1 } });
    const response = messages.pop();
    assert.equal(response.type, "RESULT", response.message);
    assert.equal(response.requestId, i + 1);
    assert.equal(response.positionRevision, serializedState.positionRevision);
    assert.equal(response.rulesVersion, serializedState.rulesVersion);
    assert.equal(response.currentPlayer, serializedState.currentPlayer);
    assert.equal(response.modelInfo.id, spec.id);
    assert.equal(response.modelInfo.seed, spec.seed);
    assert.equal(response.modelInfo.evidenceTier, "pilot");
    assert.equal(response.modelInfo.simulations, 2);
    assert.equal(response.modelInfo.cPuct, 1.5);
    assert.equal(response.moves.reduce((sum, m) => sum + m.visits, 0), 2);
    for (const m of response.moves) assert.ok(m.type === "pass" || engine.getLegalMoves(engine.currentPlayer).some((x) => x.point.join(",") === m.point.join(",")));
    assert.equal(JSON.stringify(serializedState), before);
  }
  for (const override of [{ modelId: "missing" }, { aiPlayer: "WHITE" }, { simulations: -1 }]) {
    await self.onmessage({ data: { type: "COMPUTE", serializedState, aiPlayer: engine.currentPlayer,
      strategy: "neural-puct", modelId: manifest.models[0].id, simulations: 1, requestId: 100, ...override } });
    assert.equal(messages.pop().type, "ERROR");
  }
} finally { globalThis.fetch = oldFetch; delete globalThis.self; }
console.log("verify-research-worker: PASS (9 models, identity echoes, errors, preserved source)");
