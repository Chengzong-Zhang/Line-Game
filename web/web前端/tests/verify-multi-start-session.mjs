import assert from "node:assert/strict";
import { RootMode, TerritoryRulesVersion } from "../GameEngine.js";
import {
  createLocalGameSession, loadLocalGameSession, persistLocalGameSession,
} from "../LocalGameSession.js";
import { createReplayDocument, validateReplayDocument } from "../ReplayCodec.js";

const storage = {
  value: null,
  setItem(_key, value) { this.value = value; },
  getItem() { return this.value; },
  removeItem() { this.value = null; },
};

for (const rootMode of [RootMode.FIXED_DOUBLE, RootMode.RELOCATE, RootMode.ADD]) {
  const settings = { gridSize: 9, playerCount: 2, startPlayer: "BLACK", rulesVersion: TerritoryRulesVersion.V3, rootMode };
  const actions = rootMode === RootMode.FIXED_DOUBLE ? [] : [
    { type: "player_move", point: [1, 0] },
    { type: "player_move", point: [7, 0] },
    { type: rootMode === RootMode.RELOCATE ? "player_root_relocate" : "player_root_add", point: [1, 0] },
  ];
  const session = createLocalGameSession(settings, actions);
  assert.equal(session.schemaVersion, 2);
  assert.equal(session.settings.rootMode, rootMode);
  assert.equal(persistLocalGameSession(session, storage), true);
  assert.deepEqual(loadLocalGameSession(storage), session);

  const replay = await createReplayDocument(settings, actions);
  assert.equal(replay.schemaVersion, 2);
  const verified = await validateReplayDocument(replay);
  assert.equal(verified.success, true, verified.reason);
  assert.deepEqual(verified.actions, actions);
  if (actions.length) {
    const tampered = structuredClone(replay);
    tampered.actions.at(-1).point = [8, 0];
    assert.equal((await validateReplayDocument(tampered)).success, false);
  }
}

const legacy = createLocalGameSession({
  gridSize: 9, playerCount: 2, startPlayer: "BLACK", rulesVersion: TerritoryRulesVersion.V3,
}, [{ type: "player_skip" }]);
const old = structuredClone(legacy);
old.schemaVersion = 1;
storage.value = JSON.stringify(old);
assert.equal(loadLocalGameSession(storage)?.settings.rootMode, undefined);

console.log("verify-multi-start-session: PASS (save/refresh/replay/tamper/legacy)");
