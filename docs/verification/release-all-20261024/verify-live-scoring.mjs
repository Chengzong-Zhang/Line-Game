import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const index = process.argv.indexOf('--engine');
assert.ok(index >= 0 && process.argv[index + 1], '--engine required');
const source = await readFile(process.argv[index + 1]);
const { GameEngine, Player, TerritoryRulesVersion } = await import(
  `data:text/javascript;base64,${source.toString('base64')}`);
const oldGame = new GameEngine({ gridSize: 7, playerCount: 2, rulesVersion: TerritoryRulesVersion.V2 });
const newGame = new GameEngine({ gridSize: 7, playerCount: 2, rulesVersion: TerritoryRulesVersion.V3 });
assert.equal(oldGame.getScoreboard()[Player.BLACK].area, 0);
assert.equal(newGame.getScoreboard()[Player.BLACK].area, 1);
assert.equal(newGame.getScoreboard()[Player.WHITE].area, 1);
assert.equal(oldGame.playMove([2, 0]).success, true);
assert.equal(newGame.playMove([2, 0]).success, true);
assert.equal(oldGame.getScoreboard()[Player.BLACK].area, 0);
assert.equal(newGame.getScoreboard()[Player.BLACK].area, 3);
const hole = [3, 2];
const ring = newGame.getAdjacentPositions(hole);
assert.equal(newGame._computeOwnedWallArea(ring, []), 7);
assert.equal(newGame._computeOwnedWallArea(ring, [hole]), 6);
const closed = new GameEngine({ gridSize: 7, playerCount: 2, rulesVersion: TerritoryRulesVersion.V3 });
for (const move of [[1, 0], [5, 1], [4, 0], [2, 1], [0, 5],
  [2, 3], [1, 2], [1, 4], [0, 3], [0, 4]]) {
  assert.equal(closed.playMove(move).success, true);
}
// White's selected polygon covers an enemy-containing pocket. Counting its
// polygon area would produce 11; the nine White elements score exactly nine.
assert.equal(closed.getScoreboard()[Player.BLACK].area, 10);
assert.equal(closed.getScoreboard()[Player.WHITE].area, 9);
console.log(JSON.stringify({ status: 'PASS_ACTUAL_V3_ENGINE', checks: 21,
  engineSha256: createHash('sha256').update(source).digest('hex'),
  initialScoreV2: 0, initialScoreV3: 1, openLineScoreV3: 3,
  safePocketScore: 7, enemyPocketScore: 6, closedPositionScores: [10, 9] }));
