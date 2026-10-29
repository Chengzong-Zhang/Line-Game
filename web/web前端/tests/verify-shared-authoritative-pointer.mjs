import assert from 'node:assert/strict';
import '../TopologyGameEngine.js';
import GameEngine from '../GameEngine.js';
import GameController from '../GameController.js';
import { createSurfacePreset } from '../BoardPresets.js';
for (const topology of [false,true]) {
  const engine = new GameEngine(topology ? { boardDefinition:createSurfacePreset('cylinder',{gridSize:5}), rulesVersion:'surface-v1' }
    : {gridSize:5,playerCount:2,rulesVersion:'territory-v3'});
  const move = engine.getLegalMoves()[0]; const point=topology ? move.vertexId : move.point;
  const sent=[];
  const c=Object.create(GameController.prototype);
  Object.assign(c,{engine,multiplayerEnabled:true,networkManager:{serverAuthoritative:true,sendMove:async move=>sent.push(move)},
    _getInteractionLockReason:()=>null,_getCanvasRelativePosition:()=>({x:0,y:0}),_findNearestGridPoint:()=>point,
    getGameState:()=>({positionRevision:engine.positionRevision}),_emitActionFeedback:()=>{}});
  const revision=engine.positionRevision, before=JSON.stringify(engine.getSnapshot());
  const result=c._processPointer(0,0); await Promise.resolve();
  assert.equal(result.pending,true);assert.equal(engine.positionRevision,revision);
  assert.equal(JSON.stringify(engine.getSnapshot()),before,'unacknowledged moves do not mutate the live board');
  assert.deepEqual(sent,[topology?{vertexId:point,boardHash:engine.boardHash}:point]);
}
console.log('verify-shared-authoritative-pointer: PASS (ordinary and topology move stays uncommitted until server snapshot)');
