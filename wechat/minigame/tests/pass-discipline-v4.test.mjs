import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { build } from '../tools/native-build.mjs';
import { sut,root,plain } from './helpers.mjs';
import { serializeEngineState } from '../../../web/web前端/AIStateProtocol.js';
import { passDisciplineRuleState } from '../../../web/web前端/AIPassDisciplineV2.js';
const fixture=JSON.parse(await fs.readFile(new URL('../../../web/web前端/tests/fixtures/pass-discipline-v4-terminal-states.json',import.meta.url),'utf8'));
const queries={name:'strip-cache-query',setup(ctx){ctx.onResolve({filter:/\?v=/},a=>({path:path.resolve(a.resolveDir,a.path.split('?')[0])}));}};
async function nativeWorker(forcedRawPassGuardProbe=false){
 const forced={name:'forced-raw-pass-guard-probe-only',setup(ctx){
  ctx.onLoad({filter:/[\\/]MultiplayerHardRuntime\.js$/},()=>({loader:'js',contents:`
   export function createHardRuntimeV2(){return {
    modelInfo:{implementationId:'forced-raw-pass-guard-probe-only',forcedRawPassGuardProbe:true},
    ai:{lastSearch:{algorithm:'forced-raw-pass-guard-probe-only'},getTopMoves(_source,_actor,n){
     return n>0?[{type:'pass',point:null,score:100,prior:1,visits:1}]:[];
    }}
   };}
  `}));
 }};
 const built=await build({entryPoints:[path.join(root,'src/workers/index.js')],bundle:true,write:false,platform:'browser',target:'es2018',format:'iife',plugins:[queries,...(forcedRawPassGuardProbe?[forced]:[])],define:{'import.meta.url':'undefined'},logLevel:'silent'});
 let receive,id=0;const pending=new Map();
 const context=vm.createContext({worker:{onMessage:fn=>{receive=fn},postMessage:answer=>{pending.get(answer.id)?.(plain(answer));pending.delete(answer.id)}}});
 vm.runInContext(built.outputFiles[0].text,context,{timeout:10000});
 return {context,send:(kind,settings,actions,player='BLACK')=>new Promise(resolve=>{const next=++id;pending.set(next,resolve);receive({id:next,kind,payload:{settings,actions,profile:'multiplayer-hard-v1'},context:{player}})})};
}
const real=await nativeWorker(),probe=await nativeWorker(true);
for(const entry of fixture.cases)test(`native HARD terminal margin envelope: ${entry.playerCount} seats`,async()=>{
 const settings={...sut.settingsFor(5,entry.playerCount),boardShape:'hexagon'};
 const base=sut.restoreGame(settings),birth=base.initialPositions.BLACK;
 const extra=entry.sourceState.gridEntries.find(([point,state])=>state===1&&point!==birth.join(','))[0].split(',').map(Number);
 const actions=[{type:'move',point:extra},...Array.from({length:entry.playerCount-1},()=>({type:'skip'}))];
 const engine=sut.restoreGame(settings,actions),before=sut.ruleView(engine);
 assert.equal(createHash('sha256').update(JSON.stringify(serializeEngineState(engine))).digest('hex'),entry.sourceStateSha256);
 const expectedHash=`sha256:${createHash('sha256').update(JSON.stringify(passDisciplineRuleState(engine))).digest('hex')}`;
 for(const kind of ['AI','HINT','ANALYZE']){
  // The real bounded 650ms Hard policy may publish a legal placement under
  // different timing. Such an original placement is deliberately preserved.
  const natural=await real.send(kind,settings,actions);assert.equal(natural.ok,true,natural.error);
  assert.equal(natural.result.modelInfo.forcedRawPassGuardProbe,undefined);
  assert.equal(natural.result.modelInfo.implementationId,'multiplayer-hard-cut-resilience-v1');
  assert.equal(natural.result.stateHash,before.stateHash);
  assert.ok(Array.isArray(natural.result.moves[0].point));
  const trial=sut.restoreGame(settings,actions);assert.equal(trial.playMove(natural.result.moves[0].point).success,true);
  if(natural.result.passDiscipline.status==='placement-policy-preserved')assert.equal(natural.result.passDiscipline.witness,null);
  else {assert.ok(natural.result.passDiscipline.witness.minimumReplyMargin>0);
    assert.ok(natural.result.passDiscipline.witness.minimumReplyAreaLowerBound>3);}
  assert.equal((await real.send('STATE',settings,actions)).result.stateHash,before.stateHash);
  // Explicit in-memory rawPASS stub exercises the guard branch deterministically.
  // This probe is not a natural model choice, strength or timing measurement.
  const answer=await probe.send(kind,settings,actions);assert.equal(answer.ok,true,answer.error);
  assert.equal(answer.result.modelInfo.forcedRawPassGuardProbe,true);
  assert.deepEqual(answer.result.moves[0].point,[4,4]);assert.equal(answer.result.stateHash,before.stateHash);
  const r=answer.result.passDiscipline;assert.equal(r.schema,'lifeline-ai-pass-discipline-v4');assert.equal(r.sourceStateHash,expectedHash);
  assert.equal(r.passWouldEnd,true);assert.ok(r.passMargin>0);assert.equal(r.witness.minimumReplyAreaLowerBound,7);
  assert.equal(r.witness.minimumReplyMargin,2);assert.deepEqual(r.witness.reservedReturn,[4,1]);
  assert.equal(r.witness.completeOpponentRound,false);assert.equal(r.witness.analyticCompleteRound,true);assert.equal(r.witness.replyActionsCompleted,undefined);
  assert.ok(r.witness.enemies.every(e=>e.nativeAreaUpperBound<=5));assert.ok(r.analyticalProbes.nativeAreaCalls>0);
  assert.equal((await probe.send('STATE',settings,actions)).result.stateHash,before.stateHash);
 }
 assert.equal((await real.send('AI',settings,actions,'WHITE')).error,'WRONG_PLAYER');
});
test('native terminal envelope needs no browser or cryptography globals',()=>{
 for(const name of ['URL','fetch','structuredClone','TextEncoder','crypto','window','document','wx','require'])for(const worker of [real,probe])assert.equal(vm.runInContext(`typeof ${name}`,worker.context),'undefined',name);
});
