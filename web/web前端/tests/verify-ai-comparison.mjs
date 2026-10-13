import assert from "node:assert/strict";
import GameEngine from "../GameEngine.js?v=20260910d";
import { GreedyAI, MCTSAI, MinimaxAI } from "../AIEngine.js?v=20260921c";
import { serializeEngineState } from "../AIStateProtocol.js?v=20260830a";

function buildCutPosition() {
  const engine = new GameEngine({
    gridSize: 6,
    playerCount: 2,
    startPlayer: "BLACK",
    rulesVersion: "territory-v2",
  });
  for (const point of [[3, 0], [2, 3], [3, 2]]) {
    const result = engine.playMove(point);
    assert.equal(result.success, true, `fixture move ${point} must be legal`);
  }
  return engine;
}

const engine = buildCutPosition();
const before = JSON.stringify(serializeEngineState(engine));
const legal = new Set(engine.getLegalMoves(engine.currentPlayer).map((move) => move.point.join(",")));

for (const [name, ai] of [
  ["greedy", new GreedyAI()],
  ["mcts-16", new MCTSAI({ simulations: 16, rolloutDepth: 12 })],
  ["minimax-2", new MinimaxAI(2)],
  ["minimax-3", new MinimaxAI(3)],
  ["minimax-4", new MinimaxAI(4)],
]) {
  const moves = ai.getTopMoves(engine, engine.currentPlayer, 3);
  assert.ok(moves.length > 0, `${name} must return at least one candidate`);
  for (const move of moves) {
    assert.ok(legal.has(move.point.join(",")), `${name} returned an illegal candidate`);
    assert.equal(Number.isFinite(move.score), true, `${name} candidate must have a score`);
  }
  assert.equal(JSON.stringify(serializeEngineState(engine)), before, `${name} must not mutate the source position`);
}

console.log("verify-ai-comparison: PASS");
