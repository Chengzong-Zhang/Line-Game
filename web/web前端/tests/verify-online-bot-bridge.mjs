import assert from "node:assert/strict";
import { processBotRequest } from "../../tools/online_bot_bridge.mjs";

const request = {
  settings: { playerCount: 3, rulesVersion: "territory-v2", gridSize: 5, startPlayer: "WHITE" },
  actions: [],
  botColors: ["WHITE", "PURPLE"],
};

const trained = await processBotRequest(request);
assert.equal(trained.success, true);
assert.equal(trained.fallback, false);
assert.equal(trained.action.color, "WHITE");
assert.equal(trained.action.type, "player_move");
assert.ok(trained.action.point.every(Number.isInteger));

const fallback = await processBotRequest(request, {
  chooseBotPoint() { throw new Error("injected model load failure"); },
});
assert.equal(fallback.success, true);
assert.equal(fallback.fallback, true);
assert.equal(fallback.action.color, "WHITE");
assert.ok(fallback.action.point.every(Number.isInteger));
const verifiedFallback = await processBotRequest({
  ...request,
  botColors: [],
  actions: [fallback.action],
});
assert.equal(verifiedFallback.success, true);

const impersonation = await processBotRequest({
  ...request,
  action: { type: "player_move", color: "WHITE", point: [0, 3] },
});
assert.equal(impersonation.reason, "BOT_ACTOR_FORBIDDEN");
const corrupt = await processBotRequest({
  ...request,
  actions: [{ type: "player_move", color: "BLACK", point: [0, 1] }],
});
assert.equal(corrupt.success, false);
assert.equal(corrupt.reason, "INVALID_REPLAY:OUT_OF_TURN");

// A full small-board match exercises implicit auto-passes, terminal detection
// and replay through exactly the same bridge used by the backend.
const full = { ...request, settings: { ...request.settings, startPlayer: "BLACK" }, actions: [] };
let turn = "BLACK", finished = false;
for (let count = 0; count < 100; count += 1) {
  const result = await processBotRequest({
    ...full,
    action: turn === "BLACK" ? { type: "player_skip", color: "BLACK" } : null,
  });
  assert.equal(result.success, true, result.reason);
  if (result.action) full.actions.push(result.action);
  turn = result.currentPlayer;
  if (result.gameOver) { finished = true; break; }
}
assert.equal(finished, true);
assert.equal((await processBotRequest({ ...full, botColors: [] })).gameOver, true);
console.log(JSON.stringify({
  status: "PASS", trainedModel: true, modelFailureFallback: true,
  invalidActorRejected: true, corruptHistoryRejected: true, completedGameActions: full.actions.length,
}));
