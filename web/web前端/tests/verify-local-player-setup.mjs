import assert from "node:assert/strict";
import * as setup from "../LocalAIModes.js";
import { createLocalGameSession, appendLocalGameAction, persistLocalGameSession, loadLocalGameSession } from "../LocalGameSession.js";

assert.equal(typeof setup.localPlayerProfile, "function", "each side needs its own AI profile");
assert.equal(setup.LOCAL_PLAYER_CHOICES.length, 10);
const players = setup.normalizeLocalPlayers({
  BLACK: { choice: "minimax", depth: 2 },
  WHITE: { choice: "topology-gnn", version: "2026092203" },
});
assert.deepEqual(setup.localPlayerProfile(players.BLACK), { strategy: "minimax", depth: 2 });
assert.equal(setup.localPlayerProfile(players.WHITE).modelId, "topology-gnn-transfer-v1-seed2026092203");
assert.equal(setup.localMatchMode(players), "ai_duel");
assert.equal(setup.localMatchMode({ ...players, BLACK: { choice: "human" } }), "ai_white");
assert.equal(setup.localPlayerProfile({ choice: "human" }), null);
assert.equal(setup.normalizeLocalPlayers({ BLACK: { choice: "unknown" } }).BLACK.choice, "human");
assert.equal(setup.localMatchActors(players).BLACK.depth, 2);
assert.equal(setup.localMatchActors(players).WHITE.seed, 2026092203);
assert.ok(Object.values(setup.localMatchActors(players, 3)).every((actor) => actor.kind === "human"));
for (const choice of setup.LOCAL_PLAYER_CHOICES.filter((choice) => choice !== "human")) {
  assert.ok(setup.localPlayerProfile({ choice }).strategy, `${choice} must resolve a supported profile`);
}
const values = new Map();
const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
const settings = { playerCount: 2, gridSize: 5, startPlayer: "WHITE", rulesVersion: "territory-v2" };
const match = { players, started: true, paused: true };
const session = appendLocalGameAction(createLocalGameSession(settings, [], match), { type: "skip" });
assert.equal(persistLocalGameSession(session, storage), true);
assert.deepEqual(loadLocalGameSession(storage).match, match, "refresh must retain independent players and pause state");
const legacy = createLocalGameSession(settings, [{ type: "skip" }]);
assert.equal(persistLocalGameSession(legacy, storage), true);
assert.equal(loadLocalGameSession(storage).match, undefined, "older saves stay readable");
console.log("verify-local-player-setup: PASS (10 choices, independent profiles, actor labels, save/append/load, legacy saves)");
