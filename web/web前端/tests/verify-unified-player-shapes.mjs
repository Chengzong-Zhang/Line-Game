import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import GameEngine, { PLAYER_ORDER } from '../GameEngine.js';
import { normalizeGameSettings } from '../OnlineAppState.js';
import { createReplayDocument, validateReplayDocument } from '../ReplayCodec.js';
globalThis.crypto ??= webcrypto;
let cases = 0;
for (const playerCount of [2, 6, 15]) for (const boardShape of ['triangle','diamond','hexagon']) {
  const settings = normalizeGameSettings({ playerCount, boardShape, gridSize: 5, rulesVersion: 'territory-v3' });
  assert.equal(settings.playerCount, playerCount);
  assert.equal(settings.boardShape, boardShape);
  const engine = new GameEngine(settings);
  assert.equal(engine.activePlayers.length, playerCount);
  const actions=[];
  while (!engine.gameOver) { const player=engine.currentPlayer; assert.ok(engine.skipTurn().success); actions.push({type:'skip',player}); assert.ok(actions.length <= playerCount); }
  const replay=await createReplayDocument(settings,actions,{actors:Object.fromEntries(PLAYER_ORDER.slice(0,playerCount).map(p=>[p,{kind:'human'}]))});
  assert.ok((await validateReplayDocument(replay)).success, `${boardShape}/${playerCount}`);
  assert.equal(Object.keys(replay.terminal.scores).length, playerCount);
  cases++;
}
console.log(`verify-unified-player-shapes: PASS (${cases} board/count configurations and completed replay)`);
