import assert from 'node:assert/strict';
import GameEngine, { RootMode } from '../GameEngine.js';
import { MinimaxAI, GreedyAI, MCTSAI, saveState } from '../AIEngine.js';
const engine = new GameEngine({ gridSize: 5, playerCount: 2, rulesVersion: 'territory-v3', rootMode: RootMode.ADD });
const before = saveState(engine);
for (const ai of [new MinimaxAI(4), new GreedyAI(), new MCTSAI({simulations: 20, rolloutDepth: 3})]) {
  const moves = ai.getTopMoves(engine, 'BLACK', 5, {deadline: performance.now() - 1});
  assert.ok(moves.length, `${ai.constructor.name} must return a legal candidate after expiry`);
  assert.deepEqual(saveState(engine), before, 'deadline must not leak speculative root state');
  const move = moves[0];
  const valid = move.type?.startsWith('root_') ? engine.getLegalRootActions('BLACK').some(x => x.type === move.type && String(x.point) === String(move.point))
    : engine.getLegalMoves('BLACK').some(x => String(x.point) === String(move.point));
  assert.ok(valid, 'fallback must be legal under actual roots');
  if (ai instanceof MinimaxAI) assert.equal(ai.lastSearch.completedDepth, 0);
}
console.log('verify-root-ai-deadline: PASS (expired budget, verified fallback, no state leakage)');
