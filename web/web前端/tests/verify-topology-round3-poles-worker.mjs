import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import '../TopologyGameEngine.js';
import { GameEngine } from '../GameEngine.js';
import { createSurfacePreset } from '../BoardPresets.js';
import { serializeEngineState } from '../AIStateProtocol.js';
const adapter=`const {parentPort,workerData}=require('node:worker_threads');globalThis.self={postMessage:v=>parentPort.postMessage(v)};import(workerData).then(()=>parentPort.on('message',data=>self.onmessage({data}))).catch(e=>{throw e})`;
const worker=new Worker(adapter,{eval:true,workerData:new URL('../AIWorker.js',import.meta.url).href});
function invoke(data) {return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('worker timeout')),10000);worker.once('message',v=>{clearTimeout(timeout);resolve(v)});worker.once('error',reject);worker.postMessage(data)});}
try {
 for(const name of ['cone','sphere']) {
  const game=new GameEngine({boardDefinition:createSurfacePreset(name,{gridSize:5})});let steps=0;
  while(!game.gameOver && steps<50){
   const before=game.getTopologyRuleState(), requestId=`${name}-${steps}`;
   const result=await invoke({type:'COMPUTE',requestId,strategy:'topology-generic',serializedState:serializeEngineState(game),aiPlayer:game.currentPlayer,depth:1,topN:1,timeLimitMs:800});
   assert.equal(result.type,'RESULT',result.message);assert.equal(result.boardHash,game.boardHash);assert.deepEqual(game.getTopologyRuleState(),before);
   const chosen=result.moves[0];assert.ok(chosen);
   const outcome=chosen.type==='pass'?game.skipTurn():game.playMove(chosen.vertexId);
   assert.equal(outcome.success,true,JSON.stringify({name,steps,chosen,outcome}));steps++;
   if(steps===2 || game.gameOver) {const saved=game.encodeTopologyState();const restored=new GameEngine({boardDefinition:game.boardDefinition});assert.equal(restored.restoreTopologyState(saved),true);assert.deepEqual(restored.getTopologyRuleState(),game.getTopologyRuleState());}
  }
  assert.equal(game.gameOver,true,`${name} bounded match must finish`);
  console.log(JSON.stringify({preset:name,steps,gameOver:game.gameOver,scoreboard:game.getScoreboard()}));
 }
} finally {await worker.terminate();}
