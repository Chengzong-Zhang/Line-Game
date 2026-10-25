// Bounded desktop sample, never a phone performance claim or training run.
import { performance } from 'node:perf_hooks';
import fs from 'node:fs/promises';
import { GameEngine } from '../src/core.js';
import { settingsFor } from '../src/state.js';
import { executeTask } from '../src/worker-runtime.js';
const results = [];
for (const gridSize of [5, 7, 9, 15]) {
  const settings = settingsFor(gridSize), game = new GameEngine(settings), actions = [];
  for (let i = 0; i < 10 && !game.gameOver; i++) {
    const moves = game.getLegalMoves();
    const point = moves[(i * 17 + gridSize) % moves.length].point;
    const action = { type: 'move', point, player: game.currentPlayer };
    game.playMove(point); actions.push(action);
  }
  for (const kind of ['STATE', ...(!game.gameOver ? ['AI'] : [])]) {
    for (const difficulty of kind === 'AI' ? ['easy', 'normal'] : ['none']) {
      const started = performance.now();
      const result = executeTask({ kind, payload: { settings, actions, difficulty } });
      const row = { gridSize, actions: actions.length, kind, difficulty, elapsedMs: Math.round((performance.now() - started) * 100) / 100,
        stateHash: result.stateHash };
      results.push(row); console.log(JSON.stringify(row));
    }
  }
}
if (process.argv[2]) await fs.writeFile(process.argv[2], JSON.stringify({ status: 'DESKTOP_SAMPLE_NOT_DEVICE_BENCHMARK', node: process.version, results }, null, 2) + '\n');
