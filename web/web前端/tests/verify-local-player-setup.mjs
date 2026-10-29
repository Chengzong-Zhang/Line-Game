import assert from "node:assert/strict";
import * as setup from "../LocalAIModes.js";
import { createLocalGameSession, appendLocalGameAction, persistLocalGameSession, loadLocalGameSession } from "../LocalGameSession.js";

// The setup component keeps topology starts as canonical IDs, whereas legacy
// boards use coordinate pairs.  Exercise the presentation helper directly so
// a `cv:N` identity can never be rendered as two string characters.
globalThis.Vue ??= { computed: (getter) => ({ get value() { return getter(); } }) };
const { default: LocalPlayerSetup } = await import("../LocalPlayerSetup.js");
const setupView = LocalPlayerSetup.setup({
  texts: {}, players: {}, playerCount: 2, boardShape: "custom", startPlayer: "BLACK",
});
assert.equal(setupView.formatStartingPosition("cv:12"), "cv:12");
assert.equal(setupView.formatStartingPosition([0, 3]), "(1, 4)");
assert.match(LocalPlayerSetup.template, /v-if="boardShape === 'custom'"[\s\S]*@click="\$emit\('start'\)"/,
  "custom topology boards need their own local start action because they do not use coordinate starting-point setup");
assert.match(LocalPlayerSetup.template, /:title="side\.choice === 'human' \? texts\.localHumanDescription : texts\.aiModelDescriptions\[side\.choice\]"/);
assert.doesNotMatch(LocalPlayerSetup.template, /local-player-description/);
assert.match(LocalPlayerSetup.template, /练习模式 · 棋力未评测/);

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
assert.equal(setup.localMatchActors(players, 3).BLACK.strategy, "three-player");
assert.equal(setup.localMatchActors(players, 3).PURPLE.kind, "human");
for (const human of ["BLACK", "WHITE", "PURPLE"]) {
  const three = Object.fromEntries(["BLACK", "WHITE", "PURPLE"].map((color) =>
    [color, { choice: color === human ? "human" : "three-player" }]));
  assert.equal(setup.localMatchMode(three, 3), "mixed");
  for (const color of Object.keys(three)) assert.equal(setup.localAIPlayer(three, 3, color), color === human ? null : color);
  assert.equal(Object.values(setup.localMatchActors(three, 3)).filter((actor) => actor.kind === "ai").length, 2);
}
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
