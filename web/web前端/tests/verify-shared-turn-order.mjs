import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import '../TopologyGameEngine.js';
import GameEngine from '../GameEngine.js';
import GameController from '../GameController.js';
import { SharedRoomClient } from '../SharedRoomClient.js';
import { normalizeGameSettings } from '../OnlineAppState.js';
import { coordinateControllerRoomSnapshot } from '../OnlineRoomSync.js';
import { sut, plain } from '../../../wechat/minigame/tests/helpers.mjs';
import { createTopologySetup, useTopologyPreset } from '../../../wechat/minigame/src/topology-setup.js';

globalThis.crypto ??= webcrypto;
const order = ['PURPLE','BLACK','GREEN','WHITE'];
function controller() {
  const c = Object.create(GameController.prototype), options = { gridSize:5, playerCount:2, rulesVersion:'territory-v3' };
  Object.assign(c, { canvas:{style:{},setAttribute(){}}, options:{engine:options}, engine:new GameEngine(options),
    renderer:{invalidate(){},render(){}}, _engineEpoch:1, stateChangeListener:null, networkErrorListener:null,
    multiplayerEnabled:false, localPlayer:null, roomReady:false, opponentConnected:false, networkManager:null,
    lastAction:null,lastMoves:{},_networkUnsubscribers:[],_authoritativeSnapshotValid:true });
  c._validGridPoints=c.engine.getValidPositions(); return c;
}
function makeRoom(topology) {
  const base = { gridSize:5, playerCount:4, startPlayer:order[0], turnOrder:order,
    rulesVersion:'territory-v3', boardShape:'hexagon', botCount:0 };
  let settings = base;
  if (topology) {
    const board = useTopologyPreset(createTopologySetup(), 'cylinder', { gridSize:5, playerCount:4 }).setup.definition;
    settings = { ...sut.topologySettingsFor(board, base), botCount:0 };
  }
  const engine=sut.restoreGame(settings), actions=[];
  for (const player of order) {
    assert.equal(engine.currentPlayer,player);
    const move=engine.getLegalMoves(player)[0];
    const action=topology ? {type:'move',player,vertexId:move.vertexId} : {type:'move',player,point:move.point};
    assert.equal(sut.applyAction(engine,action).success,true);actions.push(action);
  }
  const view=sut.ruleView(engine), snap=view.snapshot, players=sut.playerIds(4);
  return { protocol:1,code:'ABCDEFGH',matchId:'a'.repeat(32),revision:5,seq:actions.length,actions,
    actionIds:actions.map((_,i)=>`ordered-fixture-${i}`),player:'WHITE',hostPlayer:'BLACK',currentPlayer:snap.currentPlayer,
    status:'playing',ready:Object.fromEntries(players.map(p=>[p,true])),members:Object.fromEntries(players.map(p=>[p,true])),
    rematchVotes:{},settings,gameOver:snap.gameOver,winner:snap.winner,
    scores:Object.fromEntries(players.map(p=>[p,snap.territories[p].area])),stateHash:view.stateHash,bots:[] };
}
let rooms;
if (process.argv.includes('--stdin')) {
  let raw=''; for await (const chunk of process.stdin) raw += chunk;
  rooms = JSON.parse(raw);
  assert.equal(rooms.length, 2);
} else rooms = [makeRoom(false), makeRoom(true)];
for(const room of rooms) {
  const topology = room.settings.rulesVersion === 'surface-v1', c=controller();let payload;
  const shared=new SharedRoomClient({storage:null,onRoom:p=>{payload=p;}});
  shared.request=async()=>plain(room);shared.connect=async()=>{};
  await shared.enter('join',room.code);
  assert.equal(payload.type,'ROOM_JOINED'); assert.deepEqual(shared.engine.turnOrder,order);
  const incoming=normalizeGameSettings(payload.settings); assert.deepEqual(incoming.turnOrder,order);
  const result=coordinateControllerRoomSnapshot({controller:c,payload,incomingSettings:incoming,
    syncOnlineController(){},applySettingsToController(){}});
  assert.equal(result.success,true,result.reason);assert.deepEqual(c.engine.turnOrder,order);
  const state=topology?c.engine.encodeTopologyState():sut.serializeRuleState(c.engine);
  assert.equal(sut.checksum(state),room.stateHash);assert.equal(c.engine.currentPlayer,room.currentPlayer);
  const bad=plain(room);bad.settings.turnOrder=['PURPLE','BLACK','BLACK','WHITE'];bad.revision++;
  await assert.rejects(shared.receive(bad),/INVALID_TURN_ORDER/);
  assert.throws(()=>normalizeGameSettings(bad.settings),/INVALID_TURN_ORDER/);
  assert.equal(shared.room.stateHash,room.stateHash);
  // An old room after an ordered match cannot inherit the previous ordering.
  const old={gridSize:5,playerCount:4,startPlayer:'WHITE',boardShape:'hexagon',rulesVersion:'territory-v3'};
  const legacy=c.restoreMatchState({settings:old,actions:[]}); assert.equal(legacy.success,true,legacy.reason);
  assert.equal(c.engine.explicitTurnOrder,false);assert.equal(c.engine._getNextPlayer('WHITE'),'PURPLE');
  shared.stop();
}
console.log('verify-shared-turn-order: PASS (Mini rules, Web join, controller replay/hash, topology and legacy rejection)');
