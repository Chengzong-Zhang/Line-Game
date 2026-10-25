import assert from "node:assert/strict";
import { GameEngine } from "../GameEngine.js?v=20261025-room1";
import { normalizeRoomPlayerSetup, roomSettingsFromBoard, roomBotColors, roomHumanColors,
  roomPlayerFromController, roomControllerFromPlayer, roomPlayerProfile } from "../OnlineRoomSettings.js";
import { createRoomBotRuntime } from "../../tools/online_bot_runtime.mjs";
import { processBotRequest } from "../../tools/online_bot_bridge.mjs";

const settings = { playerCount: 4, boardShape: "hexagon", gridSize: 5, rulesVersion: "territory-v3", startPlayer: "BLACK" };
const seats = {
  BLACK: { choice: "ai-easy" }, WHITE: { choice: "human" },
  PURPLE: { choice: "ai-hard" }, GREEN: { choice: "human" },
};
const mixed = roomSettingsFromBoard(settings, seats);
assert.deepEqual(roomBotColors(mixed), ["BLACK", "PURPLE"]);
assert.deepEqual(roomHumanColors(mixed), ["WHITE", "GREEN"]);
assert.equal(mixed.botCount, 2);
assert.equal(mixed.playerSetup.PURPLE.choice, "ai-hard");
assert.deepEqual(Object.keys(mixed.playerSetup), ["BLACK", "WHITE", "PURPLE", "GREEN"]);
assert.equal(seats.BLACK.depth, undefined, "normalization must not mutate the cabin draft");
assert.deepEqual(roomBotColors({ ...settings, botCount: 2 }), ["PURPLE", "GREEN"]);
assert.equal(normalizeRoomPlayerSetup({ ...settings, playerSetup: Object.fromEntries(Object.keys(seats).map(color => [color, { choice: "ai-medium" }])) }).BLACK.choice, "human");

for (const playerCount of [2, 3, 4, 5, 6]) {
  for (const boardShape of ["triangle", "hexagon"]) {
    const context = { ...settings, playerCount, boardShape, botCount: playerCount - 1 };
    assert.equal(roomBotColors(context).length, playerCount - 1);
    assert.deepEqual(roomHumanColors(context), ["BLACK"]);
  }
}

const two = { ...settings, playerCount: 2, boardShape: "triangle" };
for (const controller of ["human", "greedy", "minimax-2", "minimax-3", "minimax-4", "model:dqn-all-sizes-e2000",
  "model:gail-all-sizes", "model:padded-cnn-transfer-v1-seed2026092202", "model:grid-gnn-d14-s20260825-g200"]) {
  const player = roomPlayerFromController(controller, two);
  assert.equal(roomControllerFromPlayer(player, two), controller, `native controller round trip: ${controller}`);
}
for (const controller of ["three-player-policy-v1", "three-player-policy-v2", "three-player-search-v4-round12",
  "multiplayer-easy-v1", "multiplayer-medium-v1", "multiplayer-hard-v1"]) {
  const context = { ...settings, playerCount: 3, boardShape: "triangle" };
  const input = roomPlayerFromController(controller, context);
  const normalized = normalizeRoomPlayerSetup(context, { WHITE: input });
  assert.equal(roomControllerFromPlayer(normalized.WHITE, context), controller);
}
for (const controller of ["hex-player-policy-v1", "hex-player-search-v5"]) {
  const input = roomPlayerFromController(controller, settings);
  assert.equal(roomControllerFromPlayer(normalizeRoomPlayerSetup(settings, { WHITE: input }).WHITE, settings), controller);
}

// Use actual runtime instances to verify settings reach the algorithm. Merely
// checking the label sent to an injected callback would miss fixed Greedy bots.
const engine = new GameEngine(two);
for (const depth of [2, 3, 4]) {
  const profile = roomPlayerProfile({ choice: "minimax", depth }, two);
  const runtime = await createRoomBotRuntime(engine, profile);
  assert.equal(runtime.ai.constructor.name, "MinimaxAI");
  assert.equal(runtime.ai.depth, depth);
}
assert.equal((await createRoomBotRuntime(engine, { strategy: "greedy" })).ai.constructor.name, "GreedyAI");

const tierIdentities = [];
for (const choice of ["ai-easy", "ai-medium", "ai-hard"]) {
  const context = { ...settings, playerCount: 3, boardShape: "triangle", startPlayer: "WHITE",
    playerSetup: { BLACK: { choice: "human" }, WHITE: { choice }, PURPLE: { choice: "human" } } };
  const result = await processBotRequest({ settings: context, actions: [], botColors: ["WHITE"] });
  assert.equal(result.success, true, result.reason);
  assert.equal(result.fallback, false, result.fallbackReason);
  assert.equal(result.modelInfo.id, `multiplayer-${choice.slice(3)}-v1`);
  tierIdentities.push(result.modelInfo.id);
}
assert.equal(new Set(tierIdentities).size, 3);

for (const choice of ["padded-cnn", "dqn"]) {
  const context = { ...two, startPlayer: "WHITE", playerSetup: { BLACK: { choice: "human" }, WHITE: { choice, version: "legacy" } } };
  const result = await processBotRequest({ settings: context, actions: [] });
  assert.equal(result.success, true, result.reason);
  assert.equal(result.fallback, false, result.fallbackReason);
  assert.equal(result.botProfile.strategy, choice === "dqn" ? "model-free" : "neural-puct");
  assert.equal(result.modelInfo.id, result.botProfile.modelId);
}

const firstAI = await processBotRequest({ settings: mixed, actions: [], botColors: ["BLACK", "PURPLE"] });
assert.equal(firstAI.success, true, firstAI.reason);
assert.equal(firstAI.action.color, "BLACK", "host may occupy a later human seat");
assert.equal(firstAI.currentPlayer, "WHITE");
const mismatch = await processBotRequest({ settings: mixed, actions: [], botColors: ["PURPLE", "GREEN"] });
assert.equal(mismatch.reason, "INVALID_CONFIGURATION");
for (const playerSetup of [[], { BLACK: { choice: "not-an-ai" } }, { BLACK: { choice: "minimax", depth: 99 } },
  Object.fromEntries(["BLACK", "WHITE", "PURPLE", "GREEN"].map(color => [color, { choice: "ai-easy" }]))]) {
  assert.equal((await processBotRequest({ settings: { ...settings, playerSetup }, actions: [] })).reason, "INVALID_CONFIGURATION");
}
const blocked = await processBotRequest({
  settings: { ...settings, startPlayer: "WHITE", playerSetup: { BLACK: { choice: "human" }, WHITE: { choice: "ai-ultimate" } } }, actions: [],
});
assert.equal(blocked.success, false);
assert.match(blocked.reason, /^ULTIMATE_/);
assert.equal(blocked.action, undefined);
console.log(JSON.stringify({ status: "PASS", interleavedSeats: true, controllerRoundTrips: true,
  boardContexts: 10, minimaxDepths: [2, 3, 4], actualTierIdentities: tierIdentities,
  researchAndModelFreeInference: true, botColorsMismatchRejected: true, ultimateAdmissionPreserved: true }));
