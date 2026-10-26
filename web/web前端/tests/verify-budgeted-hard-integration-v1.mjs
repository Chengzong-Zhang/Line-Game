// Product wiring only. Timed/shallow decisions are not defensive teacher labels.
import assert from 'node:assert/strict';
import { GameEngine } from '../GameEngine.js';
import { MinimaxAI, saveState } from '../AIEngine.js';
import { BudgetedMinimaxAI } from '../BudgetedMinimaxAI.js';
import { multiplayerClock } from '../MultiplayerClock.js';
import { serializeEngineState } from '../AIStateProtocol.js';
import { chooseRoomBotMove, createRoomBotRuntime } from '../../tools/online_bot_runtime.mjs';
import { processBotRequest } from '../../tools/online_bot_bridge.mjs';

const settings = { gridSize: 5, playerCount: 2, boardShape: 'triangle', rulesVersion: 'territory-v3', startPlayer: 'BLACK' };
const prefix = [[0,2],[1,3],[0,3],[3,1]];
function position() {
  const engine = new GameEngine({ ...settings, deferTerritoryUpdates: true });
  engine._isReplayingBatch = true;
  for (const point of prefix) assert.equal(engine.playMove(point).success, true);
  engine._isReplayingBatch = false; engine.getSnapshot(); return engine;
}
const answers = []; globalThis.self = { postMessage: message => answers.push(message) };
await import('../AIWorker.js?budgeted-hard-product-integration-v1');
const compute = self.onmessage, oldClock = multiplayerClock.now;
const rows = [];
async function web(engine, depth, topN = 1) {
  const serializedState = serializeEngineState(engine), before = JSON.stringify(serializedState); answers.length = 0;
  await compute({ data: { type:'COMPUTE', strategy:'minimax', depth, topN, aiPlayer:engine.currentPlayer,
    serializedState, requestId:`hard-budget-${depth}-${topN}` } });
  assert.equal(JSON.stringify(serializedState), before);
  const result = answers.find(message => message.type === 'RESULT');
  assert.ok(result, JSON.stringify(answers)); assert.equal(result.requestId, `hard-budget-${depth}-${topN}`);
  assert.equal(result.positionRevision, engine.positionRevision); assert.equal(result.rulesVersion, engine.rulesVersion);
  return result;
}
try {
  multiplayerClock.now = () => 0;
  const referenceEngine = position(), reference = new BudgetedMinimaxAI({ now: multiplayerClock.now, timeMs:3000, reserveMs:200, maxDepth:8 });
  const ranking = reference.getTopMoves(referenceEngine, 'BLACK', 5, { startedAt:0, deadline:3000 });
  const source = position(), before = saveState(source), product = await web(source, 4);
  assert.deepEqual(product.moves, ranking.slice(0,1)); assert.deepEqual(saveState(source), before);
  assert.equal(product.searchStats.algorithm, 'budgeted-minimax-candidate-v1');
  assert.equal(product.searchStats.completedDepth, reference.lastSearch.completedDepth);
  assert.equal(product.searchStats.totalDeadline, 3000); assert.equal(product.searchStats.guardReserveMs, 200);
  assert.equal(product.searchStats.trainingLabel, false); assert.equal(product.searchStats.totalElapsedMs, 0);
  const room = await chooseRoomBotMove(source, { strategy:'minimax', depth:4 });
  assert.deepEqual(room.point, product.moves[0].point); assert.equal(room.searchStats.completedDepth, product.searchStats.completedDepth);
  assert.equal(room.searchStats.totalDeadline, 3000); assert.deepEqual(saveState(source), before);
  const bridgeSettings = { ...settings, playerSetup:{ BLACK:{choice:'minimax',depth:4}, WHITE:{choice:'human'} } };
  const request = { settings:bridgeSettings, actions:prefix.map((point,index)=>({type:'player_move',color:index%2?'WHITE':'BLACK',point})), botColors:['BLACK'] };
  const bridged = await processBotRequest(request);
  assert.equal(bridged.success,true); assert.equal(bridged.fallback,false);
  assert.equal(bridged.searchStats.algorithm,'budgeted-minimax-candidate-v1');
  assert.equal(bridged.searchStats.completedDepth,product.searchStats.completedDepth);
  assert.equal(bridged.searchStats.startedAt,0); assert.deepEqual(bridged.action.point,product.moves[0].point);
  rows.push('Web,room runtime and actual bridge share completed iteration, deadline and legal action');
  for (const depth of [2,3]) {
    const original = new MinimaxAI(depth).getTopMoves(position(),'BLACK',5);
    const answer = await web(position(),depth);
    assert.deepEqual(answer.moves,original.slice(0,1)); assert.equal(answer.searchStats.depth,depth);
    assert.equal(answer.searchStats.totalDeadline,undefined);
    const runtime = await createRoomBotRuntime(position(),{strategy:'minimax',depth});
    assert.equal(runtime.ai.constructor.name,'MinimaxAI'); assert.equal(runtime.ai.depth,depth);
  }
  rows.push('Easy and Medium preserve the original fixed-depth class and rankings');
  const noOutput = await web(position(),4,0); assert.deepEqual(noOutput.moves,[]);
  rows.push('Hard topN0 preserves no-output request semantics');
  let ticks = 0; multiplayerClock.now = () => ++ticks >= 2 ? 5000 : 0;
  const expired = await web(position(),4);
  assert.equal(expired.searchStats.startedAt,0); assert.equal(expired.searchStats.totalDeadline,3000);
  assert.equal(expired.searchStats.completedDepth,0); assert.equal(expired.searchStats.fallback,'legal-placement');
  assert.equal(expired.searchStats.shallowQualityTradeoff,true); assert.equal(expired.searchStats.trainingLabel,false);
  assert.equal(expired.searchStats.remainingMs,0); assert.equal(expired.searchStats.totalElapsedMs,5000);
  assert.equal(expired.searchStats.totalOverrunMs,2000); assert.ok(Array.isArray(expired.moves[0].point));
  ticks=0;
  const lateBridge=await processBotRequest(request);
  assert.equal(lateBridge.success,true); assert.equal(lateBridge.fallback,false);
  assert.equal(lateBridge.searchStats.startedAt,0); assert.equal(lateBridge.searchStats.totalDeadline,3000);
  assert.equal(lateBridge.searchStats.completedDepth,0); assert.equal(lateBridge.searchStats.shallowQualityTradeoff,true);
  assert.equal(lateBridge.searchStats.totalElapsedMs,5000); assert.ok(Array.isArray(lateBridge.action.point));
  rows.push('Reconstruction consumes the existing deadline; expired budget reports fallback/overrun without an unlimited base4');
  console.log(JSON.stringify({status:'PASS_BUDGETED_HARD_PRODUCT_INTEGRATION_V1',groups:rows,
    scope:'Deterministic clocks and one legal tactical fixture; not real-device latency or a strength claim',trainingLabels:0}));
} finally { multiplayerClock.now = oldClock; delete globalThis.self; }
