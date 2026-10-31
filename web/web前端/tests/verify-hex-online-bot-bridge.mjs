import assert from "node:assert/strict";
import { processBotRequest } from "../../tools/online_bot_bridge.mjs";

const colors = ["BLACK", "WHITE", "PURPLE", "GREEN", "ORANGE", "CYAN"];
for (const playerCount of [4, 5, 6]) {
  const request = {
    settings: { playerCount, rulesVersion: "territory-v2", gridSize: 5, startPlayer: "WHITE" },
    actions: [], botColors: colors.slice(1, playerCount),
  };
  for (const botCount of [1, playerCount - 1]) {
    const pending = { ...request, actions: [], botColors: colors.slice(1, botCount + 1) };
    for (let index = 1; index <= botCount; index++) {
      const result = await processBotRequest(pending);
      assert.equal(result.success, true, result.reason);
      assert.equal(result.fallback, false, "normal play must use the trained hex model");
      assert.equal(result.action?.color, colors[index]);
      assert.equal(result.action?.type, "player_move");
      pending.actions.push(result.action);
    }
    const verification = await processBotRequest({ ...pending, botColors: [] });
    assert.equal(verification.success, true, verification.reason);
    assert.equal(verification.action, null);
  }
  const fallback = await processBotRequest(request, {
    chooseBotPoint() { throw new Error("injected model failure"); },
  });
  assert.equal(fallback.success, true);
  assert.equal(fallback.fallback, true);
  assert.equal((await processBotRequest({ ...request, botColors: [], actions: [fallback.action] })).success, true);
  assert.equal((await processBotRequest({ ...request, action: { type: "player_skip", color: "WHITE" } })).reason, "BOT_ACTOR_FORBIDDEN");
  assert.equal((await processBotRequest({
    ...request, actions: [{ type: "player_skip", color: "BLACK" }],
  })).reason, "INVALID_REPLAY:OUT_OF_TURN");
  for (const invalid of [
    { ...request, botColors: colors.slice(0, playerCount) },
    { ...request, botColors: ["WHITE", "WHITE"] },
    { ...request, botColors: ["FAKE"] },
    { ...request, settings: { ...request.settings, gridSize: 99 } },
    { ...request, settings: { ...request.settings, startPlayer: "FAKE" } },
  ]) {
    assert.equal((await processBotRequest(invalid)).reason, "INVALID_CONFIGURATION");
  }
}
console.log("verify-hex-online-bot-bridge: PASS (trained 4/5/6 one/multiple AI, canonical fallback, actor/history/config guards)");
