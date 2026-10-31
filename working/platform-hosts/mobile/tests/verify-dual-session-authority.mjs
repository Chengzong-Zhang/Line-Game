import assert from 'node:assert/strict';
import '../../web/web前端/TopologyGameEngine.js';
import GameEngine from '../../web/web前端/GameEngine.js';
import { CONCAVE_GAP_DEFINITION } from '../../web/web前端/tests/fixtures/board-topology-v1-fixtures.mjs';
import { initializeSessionAuthority } from '../src/session-authority.js';
import { createLocalGameSession, createTopologyLocalGameSession, persistLocalGameSession,
  persistTopologyLocalGameSession, loadTopologyLocalGameSession, clearTopologyLocalGameSession } from '../../web/web前端/LocalGameSession.js';
const ordinary = 'lifeline-local-game-session-v1', topology = 'lifeline-topology-local-game-session-v1';
const values = new Map(), durable = new Map(); let failLocal = '', failNative = '';
const storage = { getItem:k=>values.get(k) ?? null, setItem(k,v){ if(k===failLocal) throw Error('local fail'); values.set(k,String(v)); }, removeItem:k=>values.delete(k) };
const native = { load: async key => ({value:durable.get(key) ?? null}), write:async (v,key)=>{if(key===failNative) throw Error('native fail'); durable.set(key,v);} };
globalThis.__LIFELINE_MOBILE_APP__ = true;
globalThis.dispatchEvent = () => {}; globalThis.CustomEvent = class { constructor(type, init) { this.type=type; this.detail=init.detail; } };
const game = createLocalGameSession({gridSize:5,playerCount:2,startPlayer:'BLACK',rulesVersion:'territory-v3'}, []);
const engine = new GameEngine({boardDefinition:CONCAVE_GAP_DEFINITION,playerCount:2,startPlayer:'WHITE',rulesVersion:'surface-v1'});
const vertexId=engine.getLegalMoves()[0].vertexId; assert.equal(engine.playMove(vertexId).success,true);
const topo=createTopologyLocalGameSession(engine.encodeTopologyState(),[{type:'player_move',vertexId}],{startPlayer:'WHITE'});
// Old non-envelope copies are independently migrated, including the old ordinary native key.
values.set(ordinary,JSON.stringify(game)); durable.set(ordinary,JSON.stringify(game)); values.set(topology,JSON.stringify(topo));
let authority=await initializeSessionAuthority({storage,native,reportStatus(){}}); await authority.flushSessionMirror();
assert.equal(JSON.parse(values.get(ordinary)).revision,1); assert.equal(JSON.parse(values.get(topology)).revision,1);
assert.equal(values.get(ordinary),durable.get(ordinary)); assert.equal(values.get(topology),durable.get(topology));
assert.deepEqual(loadTopologyLocalGameSession(storage).topologyState,topo.topologyState);
const ordinaryBefore=values.get(ordinary); assert.equal(clearTopologyLocalGameSession(storage),true); await authority.flushSessionMirror();
assert.equal(values.get(ordinary),ordinaryBefore); assert.equal(JSON.parse(durable.get(topology)).state,'cleared');
assert.equal(persistTopologyLocalGameSession(topo,storage),true); await authority.flushSessionMirror();
assert.equal(JSON.parse(values.get(topology)).revision,3); assert.equal(JSON.parse(values.get(ordinary)).revision,1);
// Restart restores a newer native topology record independently of ordinary.
values.delete(topology); authority=await initializeSessionAuthority({storage,native,reportStatus(){}}); await authority.flushSessionMirror();
assert.deepEqual(loadTopologyLocalGameSession(storage).topologyState,topo.topologyState); assert.equal(values.get(ordinary),ordinaryBefore);
// Conflicting equal revisions block only the affected key.
const conflicting = JSON.parse(values.get(topology)); conflicting.state='cleared'; delete conflicting.payload; durable.set(topology,JSON.stringify(conflicting));
authority=await initializeSessionAuthority({storage,native,reportStatus(){}}); assert.equal(authority.topologyRecovery.blocked,true);
const localBefore=values.get(topology), nativeBefore=durable.get(topology); assert.equal(persistTopologyLocalGameSession(topo,storage),false);
assert.equal(values.get(topology),localBefore); assert.equal(durable.get(topology),nativeBefore);
assert.equal(persistLocalGameSession(game,storage),true); await authority.flushSessionMirror(); assert.equal(JSON.parse(values.get(ordinary)).revision,2);
// Resolve explicitly, then ensure local failure does not overwrite either durable record.
assert.equal(clearTopologyLocalGameSession(storage),true); await authority.flushSessionMirror(); const old=values.get(topology), nativeOld=durable.get(topology);
failLocal=topology; assert.equal(persistTopologyLocalGameSession(topo,storage),false); failLocal='';
assert.equal(values.get(topology),old); assert.equal(durable.get(topology),nativeOld);
failNative=topology; assert.equal(persistTopologyLocalGameSession(topo,storage),true); await assert.rejects(authority.flushSessionMirror());
assert.equal(durable.get(topology),nativeOld); failNative=''; assert.equal(persistTopologyLocalGameSession(topo,storage),true); await authority.flushSessionMirror();
assert.equal(values.get(topology),durable.get(topology));
console.log('verify-dual-session-authority: PASS');

