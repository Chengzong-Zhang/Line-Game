import assert from "node:assert/strict";
import {
  LOCAL_GAME_SESSION_STORAGE_KEY, appendLocalGameAction, createLocalGameSession,
  loadLocalGameSession, persistLocalGameSession,
} from "../LocalGameSession.js";
import { LOCAL_PLAYER_COLORS, normalizeLocalPlayers } from "../LocalAIModes.js";

const entries = new Map();
const storage = { getItem: (key) => entries.get(key), setItem: (key, value) => entries.set(key, value) };
for (const playerCount of [4, 5, 6]) {
  const settings = { playerCount, gridSize: 5, startPlayer: "WHITE", rulesVersion: "territory-v2" };
  for (const botCount of [1, playerCount - 1]) {
    const players = normalizeLocalPlayers(Object.fromEntries(
      LOCAL_PLAYER_COLORS.map((color, index) => [color, { choice: index > 0 && index <= botCount ? "hex-player" : "human" }]),
    ), playerCount);
    const match = { players, started: true, paused: true };
    const session = appendLocalGameAction(createLocalGameSession(settings, [], match), { type: "skip" });
    assert.equal(persistLocalGameSession(session, storage), true);
    assert.deepEqual(loadLocalGameSession(storage), session);
    assert.equal(Object.values(loadLocalGameSession(storage).match.players).filter((seat) => seat.choice === "hex-player").length, botCount);
    for (const invalidChoice of ["minimax", "three-player", "dqn", "unknown"]) {
      const invalid = structuredClone(session);
      invalid.match.players.WHITE.choice = invalidChoice;
      storage.setItem(LOCAL_GAME_SESSION_STORAGE_KEY, JSON.stringify(invalid));
      assert.equal(loadLocalGameSession(storage), null, `${invalidChoice} must not restore as a hex policy`);
    }
    const oldRules = structuredClone(session);
    oldRules.settings.rulesVersion = "territory-v1";
    storage.setItem(LOCAL_GAME_SESSION_STORAGE_KEY, JSON.stringify(oldRules));
    assert.equal(loadLocalGameSession(storage), null, "hex AI requires its trained territory-v2 rules");
  }
  const legacy = createLocalGameSession(settings, [], {
    players: normalizeLocalPlayers({}, playerCount), started: true, paused: false,
  });
  assert.equal(persistLocalGameSession(legacy, storage), true);
  assert.deepEqual(loadLocalGameSession(storage), legacy, "old human-only hex sessions stay readable");
}
console.log("verify-hex-ai-persistence: PASS (4/5/6 one/multiple AI seats, pause/action restore, legacy humans, wrong-policy rejection)");
