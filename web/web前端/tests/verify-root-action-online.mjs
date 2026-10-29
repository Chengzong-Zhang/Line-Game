import assert from "node:assert/strict";
import { processBotRequest } from "../../tools/online_bot_bridge.mjs";

for (const rootMode of ["relocate", "add"]) {
  const settings = {
    playerCount: 2, gridSize: 5, boardShape: "triangle", startPlayer: "BLACK",
    rulesVersion: "territory-v3", rootMode, rootRulesVersion: "root-v2",
  };
  const actions = [
    { type: "player_move", color: "BLACK", point: [1, 0], actionId: `${rootMode}-1`, actionIndex: 1 },
    { type: "player_move", color: "WHITE", point: [3, 0], actionId: `${rootMode}-2`, actionIndex: 2 },
  ];
  const accepted = await processBotRequest({ settings, actions, botColors: [], action: {
    type: `player_root_${rootMode}`, color: "BLACK", point: [1, 0], actionId: `${rootMode}-3`,
  } });
  assert.equal(accepted.success, true, `${rootMode}: ${accepted.reason}`);
  assert.equal(accepted.currentPlayer, "WHITE");
  const replayed = await processBotRequest({ settings, actions: [...actions, {
    type: `player_root_${rootMode}`, color: "BLACK", point: [1, 0], actionId: `${rootMode}-3`, actionIndex: 3,
  }], botColors: [] });
  assert.equal(replayed.success, true, `${rootMode} replay: ${replayed.reason}`);
  const acceptedAction = { type: `player_root_${rootMode}`, color: "BLACK", point: [1, 0] };
  const repeated = await processBotRequest({ settings, actions: [...actions, acceptedAction], botColors: [], action: acceptedAction });
  assert.equal(repeated.success, false, "a repeated/out-of-turn root event must not be applied twice");
}

console.log("verify-root-action-online: PASS (dynamic actions are replayed and validated by the authoritative rule bridge)");
