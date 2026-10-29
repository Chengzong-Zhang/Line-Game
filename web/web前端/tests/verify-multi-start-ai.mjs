import assert from "node:assert/strict";
import GameEngine, { RootMode, TerritoryRulesVersion } from "../GameEngine.js";
import { GreedyAI, MCTSAI, MinimaxAI, restoreState, saveState } from "../AIEngine.js";
import { isolatedSearchEngine } from "../MultiplayerSearch.js";
import { loadMultiplayerRuntime } from "../MultiplayerRuntime.js";
import { supportsResearchInference } from "../ResearchAI.js";

const settings = {
  gridSize: 5, playerCount: 2, boardShape: "triangle", startPlayer: "BLACK",
  rulesVersion: TerritoryRulesVersion.V3, rootMode: RootMode.FIXED_DOUBLE,
};
for (const ai of [new GreedyAI(), new MinimaxAI(2), new MCTSAI({ simulations: 24, rolloutDepth: 6, seed: 17 })]) {
  const engine = new GameEngine(settings);
  const before = saveState(engine);
  const moves = ai.getTopMoves(engine, "BLACK", 5);
  assert.ok(moves.length > 0, `${ai.constructor.name} must return a candidate`);
  assert.deepEqual(saveState(engine), before, `${ai.constructor.name} must not mutate the live multi-root state`);
  for (const move of moves) {
    const isolated = new GameEngine(settings);
    restoreState(isolated, before);
    const result = move.type === "pass" ? isolated.skipTurn() : isolated.playMove(move.point);
    assert.equal(result.success, true, `${ai.constructor.name} returned an illegal candidate`);
  }
}

const guarded = new GameEngine(settings);
assert.throws(() => isolatedSearchEngine(guarded), /does not support multi-root/);
await assert.rejects(() => loadMultiplayerRuntime("multiplayer-hard-v1", guarded), /does not support multi-root/);
assert.equal(supportsResearchInference({ browser_inference: { board_size_range: [5, 15], rules_versions: ["territory-v3"] } }, guarded), false);

console.log("verify-multi-start-ai: PASS (generic search is rule-complete; legacy model and optimized paths fail closed)");
