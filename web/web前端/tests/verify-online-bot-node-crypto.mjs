import assert from "node:assert/strict";

// Simulate the supported Node 18 configuration without a global Web Crypto API.
Reflect.deleteProperty(globalThis, "crypto");
assert.equal(globalThis.crypto, undefined);
const { processBotRequest } = await import("../../tools/online_bot_bridge.mjs");
assert.ok(globalThis.crypto?.subtle);
const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc"));
assert.equal(Buffer.from(digest).toString("hex"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
const request = {
  settings: { playerCount: 6, rulesVersion: "territory-v2", gridSize: 5, startPlayer: "WHITE" },
  actions: [], botColors: ["WHITE"],
};
const result = await processBotRequest(request);
assert.equal(result.success, true);
assert.equal(result.fallback, false);
console.log("verify-online-bot-node-crypto: PASS (missing-global Web Crypto supplied, SHA-256 vector, trained hex model action)");
