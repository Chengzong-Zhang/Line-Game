import assert from 'node:assert/strict';
import '../TopologyGameEngine.js';
import GameEngine from '../GameEngine.js';
import GameController from '../GameController.js';
import { createSurfacePreset } from '../BoardPresets.js';
const noop=()=>{};
const definition=createSurfacePreset('cylinder',{gridSize:5});
const settings={boardDefinition:definition,playerCount:2,startPlayer:'BLACK',rulesVersion:'surface-v1',gridSize:5};
const engine=new GameEngine(settings), hash=engine.boardHash;
const actions=[{type:'player_move',vertexId:'cv:4',boardHash:hash},{type:'player_move',vertexId:'cv:3',boardHash:hash},{type:'player_skip'},{type:'player_move',vertexId:'cv:8',boardHash:hash}];
const controller=()=>{const c=Object.assign(Object.create(GameController.prototype),{
 canvas:{style:{},setAttribute:noop},options:{engine:settings},engine:new GameEngine(settings),_validGridPoints:[],_engineEpoch:1,_authoritativeSnapshotValid:true,
 multiplayerEnabled:false,localPlayer:null,roomReady:false,opponentConnected:false,readOnlyMode:false,lastAction:null,lastMoves:{},inspectionOverlay:null,_networkUnsubscribers:[],
 _cancelTerritoryRefresh:noop,_scheduleTerritoryRefresh:noop,_updateLargeBoardClass:noop,_syncCanvasInteractivity:noop,_syncSnapshot:noop,_reportNetworkError:noop,
 renderer:{invalidate:noop,render:noop,clearHintPoint:noop}});return c;};
const live=controller();
assert.equal(live._applyMove('cv:4').success,true);assert.equal(live._applyMove('cv:3').success,true);
assert.equal(live.skipTurn().success,true);assert.deepEqual(live.lastMoves,{WHITE:'cv:3'},'PASS clears only the acting player');
assert.equal(live._applyMove('cv:8').success,true);assert.deepEqual(live.lastMoves,{WHITE:'cv:8'},'live cut removes captured marker');
live.resetGame({force:true});assert.deepEqual(live.lastMoves,{},'reset clears markers');
// A direct cut of the opponent's most recent node must discard its marker,
// even before the opponent acts or passes again.
const mobiusSettings={...settings,boardDefinition:createSurfacePreset('mobius',{gridSize:5})};
const mobius=new GameEngine(mobiusSettings), mobiusHash=mobius.boardHash;
const cutActions=[{type:'player_move',vertexId:'cv:3',boardHash:mobiusHash},{type:'player_move',vertexId:'cv:2',boardHash:mobiusHash}];
const directCut=controller();assert.equal(directCut.restoreMatchState({settings:mobiusSettings,actions:cutActions}).success,true);
assert.deepEqual(directCut.lastMoves,{WHITE:'cv:2'},'cut removes a captured opponent latest node immediately');
const directState=directCut.engine.encodeTopologyState();const cutRecovered=controller();
assert.equal(cutRecovered.restoreTopologyState(directState,{startPlayer:'BLACK',actions:cutActions}).success,true);
assert.deepEqual(cutRecovered.lastMoves,{WHITE:'cv:2'},'cut marker remains absent after full-state restore');
const replay=controller();
assert.equal(replay.restoreMatchState({settings,actions:actions.slice(0,2)}).success,true);
assert.deepEqual(replay.lastMoves,{BLACK:'cv:4',WHITE:'cv:3'});
assert.equal(replay.restoreMatchState({settings,actions:actions.slice(0,3)}).success,true);
assert.deepEqual(replay.lastMoves,{WHITE:'cv:3'},'PASS clears only the acting player');
const stateAfterPass=replay.engine.encodeTopologyState();
const restored=controller();assert.equal(restored.restoreTopologyState(stateAfterPass,{startPlayer:'BLACK',actions:actions.slice(0,3)}).success,true);
assert.deepEqual(restored.lastMoves,{WHITE:'cv:3'},'full history restores markers after PASS');
assert.deepEqual(restored.engine.encodeTopologyState(),stateAfterPass,'marker recovery does not change rule state/history');
assert.equal(replay.restoreMatchState({settings,actions}).success,true);
assert.deepEqual(replay.lastMoves,{WHITE:'cv:8'},'cut removes captured black latest marker');
const cutState=replay.engine.encodeTopologyState();const cutRestore=controller();
assert.equal(cutRestore.restoreTopologyState(cutState,{startPlayer:'BLACK',actions}).success,true);assert.deepEqual(cutRestore.lastMoves,{WHITE:'cv:8'});
assert.equal(cutRestore.restoreMatchState({settings,actions:actions.slice(0,2)}).success,true);
assert.deepEqual(cutRestore.lastMoves,{BLACK:'cv:4',WHITE:'cv:3'},'undo/replay prefix returns matching markers');
const beforeState=cutRestore.engine.encodeTopologyState(), beforeMarkers=structuredClone(cutRestore.lastMoves);
assert.equal(cutRestore.restoreMatchState({settings,actions:[...actions,{type:'player_move',vertexId:'bad',boardHash:hash}]}).success,false);
assert.deepEqual(cutRestore.engine.encodeTopologyState(),beforeState);assert.deepEqual(cutRestore.lastMoves,beforeMarkers);
const invalid=structuredClone(beforeState);invalid.boardHash='bad';assert.equal(cutRestore.restoreTopologyState(invalid,{actions}).success,false);
assert.deepEqual(cutRestore.engine.encodeTopologyState(),beforeState);assert.deepEqual(cutRestore.lastMoves,beforeMarkers);
const legacy=controller();assert.equal(legacy.restoreTopologyState(stateAfterPass,{startPlayer:'BLACK',lastAction:{type:'move',player:'WHITE',point:'cv:3'}}).success,true);
assert.deepEqual(legacy.lastMoves,{WHITE:'cv:3'},'legacy snapshot only claims its verified last action');
const incomplete=controller();assert.equal(incomplete.restoreTopologyState(stateAfterPass,{startPlayer:'BLACK',actions:actions.slice(0,1)}).success,true);
assert.deepEqual(incomplete.lastMoves,{},'incomplete log never invents complete history');
console.log('verify-topology-last-moves: PASS');
