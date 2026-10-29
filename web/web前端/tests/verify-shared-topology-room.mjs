import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import '../TopologyGameEngine.js';
import GameEngine from '../GameEngine.js';
import { createSurfacePreset } from '../BoardPresets.js';
import { canonicalize } from '../ReplayCodec.js';
import { verifySharedRoom, sharedRoomPayload, sharedRoomCreateSettings } from '../SharedRoomClient.js';
globalThis.crypto ??= webcrypto;
const boardDefinition = createSurfacePreset('cylinder', { gridSize: 5 });
const initial = new GameEngine({ boardDefinition, rulesVersion:'surface-v1' });
const settings = { gridSize:5, playerCount:2, boardShape:'custom', rulesVersion:'surface-v1', boardDefinition,
 boardHash:initial.boardHash, topologyProtocolVersion:'board-topology-v1', rootMode:'classic', rootRulesVersion:'root-v1', startPlayer:'BLACK', botCount:0 };
const vertexId = initial.getLegalMoves()[0].vertexId;
assert.ok(initial.playMove(vertexId).success);
const snap = initial.getSnapshot();
const hash = `sha256:${createHash('sha256').update(canonicalize(initial.encodeTopologyState())).digest('hex')}`;
const room={protocol:1,code:'ABCDEFGH',matchId:'a'.repeat(32),revision:2,seq:1,actions:[{type:'move',player:'BLACK',vertexId}],
 actionIds:['unique-action-id'],player:'WHITE',hostPlayer:'BLACK',currentPlayer:snap.currentPlayer,status:'playing',
 ready:{BLACK:true,WHITE:true},members:{BLACK:true,WHITE:true},rematchVotes:{},settings,gameOver:snap.gameOver,winner:snap.winner,
 scores:Object.fromEntries(initial.activePlayers.map(p=>[p,snap.territories[p].area])), stateHash:hash,bots:[]};
const restored=await verifySharedRoom(structuredClone(room)); assert.equal(restored.boardHash,settings.boardHash);
assert.equal(sharedRoomPayload(room).matchState.actions[0].vertexId,vertexId);
assert.deepEqual(sharedRoomCreateSettings(settings).topologyCapabilities,['board-topology-v1']);
const bad=structuredClone(room);bad.actions[0].vertexId='not-a-vertex';await assert.rejects(()=>verifySharedRoom(bad));
console.log('verify-shared-topology-room: PASS (canonical replay, hash, capability, invalid vertex)');
