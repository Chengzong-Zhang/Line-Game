// Shares actual Canvas interaction and immutable build guards with the three-player path.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runThreePlayerBrowserCheck } from './three-player-browser-check.mjs';

const args = process.argv.slice(2);
assert.equal(args.length, 2, 'Usage: node tools/hex-player-browser-check.mjs --expected-version VERSION');
assert.equal(args[0], '--expected-version');
assert.match(args[1], /^\d+\.\d+\.\d+$/);
const { report } = await runThreePlayerBrowserCheck(args[1], {
  scenarioSpecs: [
    { language: 'zh', playerCount: 4, humanIndex: 0 },
    { language: 'zh', playerCount: 5, humanIndex: 1 },
    { language: 'en', playerCount: 6, humanIndex: 0, size: 15 },
  ],
  outputName: 'wechat-hex-player-browser', passStatus: 'PASS_REAL_EDGE_HEX_PLAYER_CANVAS_WORKER',
  extraInputs: [fileURLToPath(import.meta.url)],
});
if (!report.status.startsWith('PASS')) process.exitCode = 1;
