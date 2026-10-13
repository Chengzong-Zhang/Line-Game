import assert from "node:assert/strict";
import { resolveAIPlayer, localAIActors } from "../LocalAIModes.js";
import GameEngine from "../GameEngine.js";
import { MinimaxAI } from "../AIEngine.js";
import { serializeRuleState, createReplayDocument } from "../ReplayCodec.js";

assert.equal(resolveAIPlayer("none", "BLACK"), null);
assert.equal(resolveAIPlayer("ai_black", "WHITE"), "BLACK");
assert.equal(resolveAIPlayer("ai_white", "BLACK"), "WHITE");
const profile = { strategy: "minimax", depth: 2 };
assert.deepEqual(localAIActors("ai_duel", profile), { BLACK: { kind: "ai", ...profile }, WHITE: { kind: "ai", ...profile } });
assert.deepEqual(localAIActors("ai_black", profile).WHITE, { kind: "human" });
assert.ok(Object.values(localAIActors("ai_duel", profile, 3)).every((p) => p.kind === "human"));
const engine = new GameEngine({ gridSize: 5, playerCount: 2, rulesVersion: "territory-v2" });
const ai = new MinimaxAI(2); const actions = []; const players = new Set();
for (let turn = 0; turn < 8 && !engine.gameOver; turn++) {
  const player = resolveAIPlayer("ai_duel", engine.currentPlayer); players.add(player);
  const before = JSON.stringify(serializeRuleState(engine)); const moves = ai.getTopMoves(engine, player, 1);
  assert.equal(JSON.stringify(serializeRuleState(engine)), before);
  const point = moves[0]?.point;
  assert.ok(!point || engine.getLegalMoves(player).some((move) => move.point.join() === point.join()));
  actions.push({ type: point ? "move" : "skip", player, ...(point ? { point } : {}) });
  assert.equal((point ? engine.playMove(point) : engine.skipTurn()).success, true);
}
assert.equal(players.size, 2); const replay = await createReplayDocument({ gridSize: 5, playerCount: 2, rulesVersion: "territory-v2" }, actions);
assert.equal(replay.actions.length, actions.length);
process.stdout.write(JSON.stringify({ status: "PASS", ai_actions: actions.length, both_players: true, illegal_moves: 0, source_preserved: true, ai_roles_separate_from_humans: true }) + "\n");
