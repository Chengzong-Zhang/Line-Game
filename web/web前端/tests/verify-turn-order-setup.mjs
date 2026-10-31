import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(process.env.LIFELINE_TEST_VUE_PACKAGE ? pathToFileURL(process.env.LIFELINE_TEST_VUE_PACKAGE) : import.meta.url);
globalThis.Vue = require('vue');
globalThis.localStorage = {getItem(){return null},setItem(){},removeItem(){}};
globalThis.location = new URL('http://localhost/');
globalThis.document = { documentElement:{dataset:{}}, body: {classList:{toggle(){},add(){},remove(){}}}, addEventListener(){},removeEventListener(){} };
globalThis.addEventListener=()=>{};globalThis.removeEventListener=()=>{};
globalThis.fetch=async()=>({ok:false});
const nativeTimeout = globalThis.setTimeout; globalThis.setTimeout = (...args) => { const timer = nativeTimeout(...args); timer.unref?.(); return timer; };
const nativeInterval = globalThis.setInterval; globalThis.setInterval = (...args) => { const timer = nativeInterval(...args); timer.unref?.(); return timer; };
await import('../TopologyGameEngine.js');
const [{default:App},{default:GameEngine,PLAYER_ORDER},{normalizeGameSettings},{default:Order,resizeTurnOrder,moveTurnOrder},{createLocalGameSession,persistLocalGameSession,loadLocalGameSession}] = await Promise.all([
 import('../OnlineApp.js'),import('../GameEngine.js'),import('../OnlineAppState.js'),import('../TurnOrderSetup.js'),import('../LocalGameSession.js')]);
for(const count of [3,6,15]) {
 const base=resizeTurnOrder(null,count,'WHITE'); assert.equal(base[0],'WHITE');
 const order=moveTurnOrder(base,count-1,1); const settings=normalizeGameSettings({playerCount:count,gridSize:9,startPlayer:order[0],turnOrder:order,rulesVersion:'territory-v3'});
 const engine=new GameEngine(settings); assert.deepEqual([...engine.turnOrder],order);
 for(let i=0;i<count;i++)assert.equal(engine._getNextPlayer(order[i]),order[(i+1)%count]);
 const saved=createLocalGameSession(settings,[]); let raw; const storage={setItem(_k,v){raw=v},getItem(){return raw}}; assert.equal(persistLocalGameSession(saved,storage),true); assert.deepEqual(loadLocalGameSession(storage).settings.turnOrder,order);
 assert.throws(()=>normalizeGameSettings({...settings,turnOrder:order.map((p,i)=>i===1?order[0]:p)}),/INVALID_TURN_ORDER/);
}
const { createProductSurfacePreset } = await import('../ProductSurfacePresets.js');
const surfaceOrder = ['PURPLE','BLACK','CYAN','WHITE','ORANGE','GREEN'];
const surface = new GameEngine({ boardDefinition: createProductSurfacePreset('cylinder',{gridSize:9}), playerCount:6,
  startPlayer:surfaceOrder[0], turnOrder:surfaceOrder, rulesVersion:'surface-v1' });
assert.deepEqual([...surface.turnOrder],surfaceOrder);
const surfaceState=surface.encodeTopologyState(); assert.deepEqual(surfaceState.ruleState.turnOrder,surfaceOrder);
assert.deepEqual(resizeTurnOrder(['PURPLE','WHITE','BLACK'],4,'PURPLE'),['PURPLE','WHITE','BLACK','GREEN']);
assert.deepEqual(resizeTurnOrder(['PURPLE','WHITE','BLACK','GREEN'],2,'WHITE'),['WHITE','BLACK']);
assert.deepEqual(resizeTurnOrder(null,3,'WHITE'),['WHITE','PURPLE','BLACK']);
assert.throws(()=>resizeTurnOrder(['BLACK','BLACK'],2,'BLACK'),/INVALID_TURN_ORDER/);
let events=[];const vm={order:['BLACK','WHITE','PURPLE'],locked:false,$emit:(name,value)=>events.push([name,value])};
Order.methods.move.call(vm,2,0);assert.deepEqual(events,[['change',['PURPLE','BLACK','WHITE']]]);vm.locked=true;Order.methods.move.call(vm,0,1);assert.equal(events.length,1);
const previousWarn=console.warn;console.warn=()=>{};const app=App.setup();console.warn=previousWarn;
app.tutorialActive.value=false;await Vue.nextTick();
app.handleTurnOrderChange(['WHITE','BLACK']);await Vue.nextTick();
assert.deepEqual(app.selectedTurnOrder.value,['WHITE','BLACK']);assert.equal(app.selectedStartPlayer.value,'WHITE');
const liveBefore=new GameEngine({playerCount:2,gridSize:9,startPlayer:'BLACK',rulesVersion:'territory-v3'});
app.controller.value={engine:liveBefore, setGameConfig(settings){this.engine=new GameEngine(settings); return this.engine.getSnapshot();}};
assert.equal(app.controller.value.engine,liveBefore,'editing a draft keeps the live engine');
assert.equal(await app.startLocalMatch(),true,'start commits the draft');assert.deepEqual([...app.controller.value.engine.turnOrder],['WHITE','BLACK']);assert.equal(app.controller.value.engine.currentPlayer,'WHITE');

app.selectedPlayerCount.value=3;await Vue.nextTick();assert.deepEqual(app.selectedTurnOrder.value,['WHITE','BLACK','PURPLE']);
app.handleTurnOrderChange(['WHITE','WHITE','PURPLE']);await Vue.nextTick();assert.deepEqual(app.selectedTurnOrder.value,['WHITE','BLACK','PURPLE']);
app.roomStatus.value='waiting';app.roomSetupOpen.value=true;app.session.value={...app.session.value,shared:true,playerId:'guest'};app.roomInfo.value={...app.roomInfo.value,hostPlayerId:'host'};await Vue.nextTick();
const guestBefore=app.selectedTurnOrder.value.slice();app.handleTurnOrderChange(['PURPLE','BLACK','WHITE']);await Vue.nextTick();assert.deepEqual(app.selectedTurnOrder.value,guestBefore,'guest cannot change room draft');
app.session.value={...app.session.value,playerId:'host'};await Vue.nextTick();app.handleTurnOrderChange(['PURPLE','BLACK','WHITE']);await Vue.nextTick();assert.deepEqual(app.selectedTurnOrder.value,['PURPLE','BLACK','WHITE']);assert.equal(app.selectedStartPlayer.value,'PURPLE');
app.roomSetupOpen.value=false;app.roomStatus.value='inProgress';await Vue.nextTick();const before=app.selectedTurnOrder.value.slice();app.handleTurnOrderChange(['WHITE','BLACK','PURPLE']);await Vue.nextTick();assert.deepEqual(app.selectedTurnOrder.value,before,'active room cannot be changed through this control');
// Synchronous room creation can read a just-edited count before Vue's watcher
// has expanded the stored two-seat draft. The actual Mini shared-room suite
// exercises both create entry points with the same transition.
console.warn=()=>{};const immediate=App.setup();console.warn=previousWarn;
immediate.tutorialActive.value=false;await Vue.nextTick();
immediate.selectedPlayerCount.value=6; immediate.selectedGridSize.value=13;
immediate.selectedBoardShape.value='hexagon';immediate.selectedStartPlayer.value='GREEN';
immediate.openRoomSetup();assert.equal(immediate.roomSetupOpen.value,true);
assert.deepEqual(immediate.selectedTurnOrder.value,['GREEN','ORANGE','CYAN','BLACK','WHITE','PURPLE']);
// Do not apply the local draft repair to an authoritative malformed room.
await Vue.nextTick();immediate.roomStatus.value='waiting';immediate.session.value={...immediate.session.value,shared:true,roomId:'ABCDEFGH',playerId:'host'};
const validInfo=immediate.roomInfo.value;immediate.roomInfo.value={...immediate.roomInfo.value,hostPlayerId:'host',settings:{playerCount:3,gridSize:9,boardShape:'triangle',startPlayer:'BLACK',rulesVersion:'territory-v3',turnOrder:['BLACK','BLACK','PURPLE']}};
assert.throws(()=>immediate.openRoomSetup(),/INVALID_TURN_ORDER/);
immediate.roomInfo.value=validInfo;await Vue.nextTick();
console.log('verify-turn-order-setup: PASS');
