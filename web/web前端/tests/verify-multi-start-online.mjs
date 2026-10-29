import assert from "node:assert/strict";
import { processBotRequest } from "../../tools/online_bot_bridge.mjs";

for (const rootMode of ["fixed-double", "relocate", "add"]) {
  const settings = {
    playerCount: 2, gridSize: 5, boardShape: "triangle", startPlayer: "BLACK",
    rulesVersion: "territory-v3", rootMode, rootRulesVersion: "root-v2",
  };
  const result = await processBotRequest({
    settings, actions: [], botColors: [],
    action: { type: "player_move", color: "BLACK", point: [1, 0] },
  });
  assert.equal(result.success, true, `${rootMode}: ${result.reason}`);
  assert.equal(result.currentPlayer, "WHITE");
}

const classicBotInNewMode = await processBotRequest({
  settings: { playerCount: 3, gridSize: 5, rulesVersion: "territory-v3", rootMode: "fixed-double" },
  actions: [], botColors: ["WHITE"],
});
assert.equal(classicBotInNewMode.reason, "INVALID_CONFIGURATION");

console.log("verify-multi-start-online: PASS (server bridge accepts versioned two-player roots and rejects old bot contracts)");
