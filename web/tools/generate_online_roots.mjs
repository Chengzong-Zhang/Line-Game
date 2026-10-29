// Generate random multi-root layouts using the same rules as the clients.
// The caller persists and validates the resulting roots before publishing them.
import { randomInt } from 'node:crypto';
import { randomInitialRoots } from '../web前端/StartingPoints.js';
let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 65536) throw new Error('INPUT_TOO_LARGE');
}
const { gridSize, playerCount, rootMode, boardShape, previous } = JSON.parse(raw);
const random = () => randomInt(0, 2 ** 32) / 2 ** 32;
for (let attempt = 0; attempt < 32; attempt += 1) {
  const roots = randomInitialRoots(gridSize, playerCount, rootMode, random, boardShape);
  if (JSON.stringify(roots) !== JSON.stringify(previous)) {
    process.stdout.write(JSON.stringify(roots));
    process.exit(0);
  }
}
throw new Error('COULD_NOT_DRAW_DIFFERENT_ROOTS');
