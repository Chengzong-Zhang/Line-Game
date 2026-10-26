import assert from "node:assert/strict";
import GameEngine, { PLAYER_ORDER } from "../GameEngine.js";
import { createReplayDocument, validateReplayDocument } from "../ReplayCodec.js";
import {
  LOCAL_GAME_SESSION_STORAGE_KEY,
  createLocalGameSession,
  persistLocalGameSession,
  loadLocalGameSession,
} from "../LocalGameSession.js";
import { normalizeLocalPlayers } from "../LocalAIModes.js";
import { TrainingContribution } from "../TrainingContribution.js";
import { validateContribution } from "../../tools/validate_contribution.mjs";

const values = new Map();
const storage = {
  getItem: (key) => values.get(key),
  setItem: (key, value) => values.set(key, value),
};

for (const playerCount of [4, 5, 6]) {
  const settings = {
    playerCount, gridSize: 5, startPlayer: "WHITE", rulesVersion: "territory-v2",
    turnTimerEnabled: false, turnTimeLimitSeconds: 60, hintEnabled: false, hintMaxCount: 0,
  };
  const engine = new GameEngine(settings);
  // White's hexagonal corner is outside the old triangular gridSize bounds.
  const point = engine.getLegalMoves().find(({ point: [x, y] }) => x >= settings.gridSize || y >= settings.gridSize)?.point;
  assert.ok(point, `${playerCount} seats need a legal move beyond the old triangular bounds`);
  assert.equal(engine.playMove(point).success, true);
  const actions = [
    { type: "player_move", point },
    { type: "player_resign", color: PLAYER_ORDER[playerCount - 1] },
  ];
  const replay = await createReplayDocument(settings, actions);
  const verified = await validateReplayDocument(replay);
  assert.equal(verified.success, true, verified.reason);
  assert.deepEqual(verified.actions, actions);
  assert.deepEqual(replay.config.players, PLAYER_ORDER.slice(0, playerCount));
  assert.deepEqual(Object.keys(replay.initialState.ruleState.edges), PLAYER_ORDER.slice(0, playerCount));
  assert.deepEqual(Object.keys(replay.actions[0].effects.territoryDelta), PLAYER_ORDER.slice(0, playerCount));

  const terminalActions = Array.from({ length: playerCount }, () => ({ type: "player_skip" }));
  const completed = await createReplayDocument(settings, terminalActions);
  assert.ok(completed.terminal);
  assert.equal((await validateReplayDocument(completed)).success, true);
  assert.deepEqual(Object.keys(completed.terminal.scores), PLAYER_ORDER.slice(0, playerCount));

  // Every seat can be first, including the three newly added colors.
  for (const startPlayer of PLAYER_ORDER.slice(0, playerCount)) {
    const alternate = await createReplayDocument({ ...settings, startPlayer });
    assert.equal((await validateReplayDocument(alternate)).success, true);
  }

  const match = { players: normalizeLocalPlayers({}, playerCount), started: true, paused: false };
  const session = createLocalGameSession(settings, actions, match);
  assert.equal(persistLocalGameSession(session, storage), true);
  assert.deepEqual(loadLocalGameSession(storage), session);
  const bad = structuredClone(session);
  bad.match.players[PLAYER_ORDER[playerCount - 1]].choice = "unknown";
  storage.setItem(LOCAL_GAME_SESSION_STORAGE_KEY, JSON.stringify(bad));
  assert.equal(loadLocalGameSession(storage), null, "invalid extra-seat choices must not survive restore");

  const contribution = new TrainingContribution({ storage });
  contribution.setEnabled(true);
  assert.equal(await contribution.enqueue(settings, terminalActions, { source: "local" }), false);
  assert.equal(contribution.queue.length, 0, "hex games must stay out of the triangular training inbox");
  await assert.rejects(validateContribution({
    format: "lifeline-training-contribution", version: 1, consent: true,
    consent_policy: "anonymous-replay-training-v1", replay: completed,
    context: { source: "local", actors: {}, mixedProfiles: false, hintsEnabled: false },
  }), /dimensions/);

  const invalidPlayers = structuredClone(replay);
  invalidPlayers.config.players.reverse();
  assert.equal((await validateReplayDocument(invalidPlayers)).success, false);
  await assert.rejects(createReplayDocument(settings, [{ type: "player_move", point: [0, 0] }]), /无法回放/);
}

console.log("verify-hex-replay-session: PASS (4/5/6 seats, outer coordinates, every first seat, resign, terminal replay, local restore, training isolation)");
