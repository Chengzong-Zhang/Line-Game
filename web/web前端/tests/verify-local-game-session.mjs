import assert from "node:assert/strict";
import {
  LOCAL_GAME_SESSION_STORAGE_KEY,
  appendLocalGameAction,
  clearLocalGameSession,
  createLocalGameSession,
  loadLocalGameSession,
  persistLocalGameSession,
  sessionMatchesSettings,
} from "../LocalGameSession.js?v=20260921a";

const settings = {
  playerCount: 2,
  gridSize: 6,
  startPlayer: "BLACK",
  rulesVersion: "territory-v2",
  turnTimerEnabled: false,
  turnTimeLimitSeconds: 60,
  hintEnabled: true,
  hintMaxCount: 3,
};

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

const storage = createMemoryStorage();
const first = createLocalGameSession(settings, [{ type: "move", point: [0, 0] }]);
assert.equal(first.actions[0].type, "player_move");
assert.deepEqual(first.actions[0].point, [0, 0]);
assert.equal(persistLocalGameSession(first, storage), true);
assert.equal(storage.getItem(LOCAL_GAME_SESSION_STORAGE_KEY) !== null, true);
assert.deepEqual(loadLocalGameSession(storage), first);
assert.equal(sessionMatchesSettings(first, settings), true);
assert.equal(sessionMatchesSettings(first, { ...settings, gridSize: 9 }), false);

const second = appendLocalGameAction(first, { type: "skip" });
assert.deepEqual(second.actions.map((action) => action.type), ["player_move", "player_skip"]);
const third = appendLocalGameAction(second, { type: "resign", player: "WHITE" });
assert.deepEqual(third.actions[2], { type: "player_resign", color: "WHITE" });
assert.equal(persistLocalGameSession(third, storage), true);
assert.deepEqual(loadLocalGameSession(storage), third);

storage.setItem(LOCAL_GAME_SESSION_STORAGE_KEY, "{\"format\":\"unknown\"}");
assert.equal(loadLocalGameSession(storage), null);
assert.equal(clearLocalGameSession(storage), true);
assert.equal(storage.getItem(LOCAL_GAME_SESSION_STORAGE_KEY), null);

console.log("verify-local-game-session: PASS");
