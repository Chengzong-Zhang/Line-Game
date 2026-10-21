import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {GameEngine} from '../web前端/GameEngine.js';
import {GreedyAI} from '../web前端/AIEngine.js';
import {encodeResearchPosition,researchRelations} from '../web前端/ResearchAI.js';
import {root,sha,unseal,sealed,modelFreeState,lease} from './neural-posttraining-data.mjs';
import {loadWarm,makePosition,plansFor,validate,durable} from './neural-terminal-rollout-data-r3.mjs';

export async function verifyData(run,verifyRoot=resolve(run,'verification-work'),maxSeconds=250){
 const started=Date.now();await mkdir(verifyRoot,{recursive:true});const guard=await lease(verifyRoot);
 let done=0;try{
 run=resolve(run);const hashes=new Map(),read=async p=>{p=resolve(p);const b=await readFile(p),h=sha(b);if(hashes.has(p))assert.equal(h,hashes.get(p));hashes.set(p,h);return JSON.parse(b);};
 const identity=await read(resolve(run,'identity.json')),c=identity.config;validate(c);
 const manifest=await read(resolve(run,'manifest.json')),cp=unseal(await read(resolve(run,'checkpoint.json'))),dataProgress=await read(resolve(run,'progress.json'));
 assert.equal(dataProgress.status,'COMPLETE');assert.equal(cp.current,null);assert.equal(cp.identity,identity.identity);assert.equal(manifest.identity,identity.identity);
 assert.equal(sha(JSON.stringify({source_hashes:identity.source_hashes,binding:identity.binding})),identity.identity);
 for(const [p,h] of Object.entries({...identity.source_hashes,...identity.binding})){const b=await readFile(resolve(root,p));assert.equal(sha(b),h);hashes.set(resolve(root,p),h);}
 const warm=await loadWarm(c),plans=plansFor(c);assert.deepEqual(cp.completed,manifest.episodes);assert.equal(plans.length,cp.completed.length);
 const verifierHash=sha(await readFile(fileURLToPath(import.meta.url))),proofIdentity=sha(JSON.stringify({identity:identity.identity,manifest:hashes.get(resolve(run,'manifest.json')),verifierHash}));
 const progress=async status=>durable(resolve(verifyRoot,'progress.json'),{status,identity:proofIdentity,progress_units:done,planned_units:plans.length});
 await progress('RUNNING');
 let rollouts=0,actions=0,units=0;
 for(const [i,plan] of plans.entries()){
  const ref=cp.completed[i],path=resolve(run,ref.path),ep=await read(path);assert.equal(hashes.get(path),ref.sha256);assert.equal(ref.id,plan.id);assert.equal(ep.datasetIdentity,identity.identity);
  const proofPath=resolve(verifyRoot,'proofs',`${plan.id}.json`);let prior;
  try{prior=unseal(await read(proofPath));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(prior){assert.equal(prior.identity,proofIdentity);assert.equal(prior.game_sha256,ref.sha256);assert.equal(prior.id,plan.id);rollouts+=prior.rollouts;actions+=prior.actions;units+=prior.rollouts+1;done++;continue;}
  let requested=null;for(const [marker,status] of [['STOP','STOPPED'],['PAUSE','PAUSED']]){try{await readFile(resolve(verifyRoot,marker));requested=status;break;}catch(e){if(e.code!=='ENOENT')throw e;}}
  if(!requested&&Date.now()-started>=maxSeconds*1000)requested='YIELDED';if(requested){await progress(requested);return null;}
  const oldActions=actions,oldRollouts=rollouts;
  const pos=makePosition(plan,c,warm.models);for(const key of ['id','size','split','start','seed','actions','candidates','player'])assert.deepEqual(ep[key],pos[key],`Position ${key}`);
  const scores=pos.candidates.map(()=>[]);assert.equal(ep.rollouts.length,pos.candidates.length*c.rolloutsPerAction);
  for(const [j,r] of ep.rollouts.entries()){
   assert.equal(r.actionIndex,Math.floor(j/c.rolloutsPerAction));assert.equal(r.repeat,j%c.rolloutsPerAction);
   let state=parseInt(sha(`${c.seedNamespace}/${ep.id}/rollout/${r.repeat}`).slice(0,8),16);assert.equal(r.seed,state);
   const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
   const e=new GameEngine({gridSize:ep.size,playerCount:2,startPlayer:ep.start,rulesVersion:'territory-v2'});e._isReplayingBatch=true;
   const apply=a=>{assert.equal(e.currentPlayer,a.player);assert.equal(e.gameOver,false);assert.ok((a.point===null?e.skipTurn():e.playMove(a.point)).success);};
   for(const a of ep.actions)apply(a);
   for(const [k,a] of r.actions.entries()){
    let expected;if(k===0)expected=ep.candidates[r.actionIndex];else{const legal=e.getLegalMoves(e.currentPlayer);expected=!legal.length?null:random()<0.5?new GreedyAI().getTopMoves(e,e.currentPlayer,1)[0].point:legal[Math.floor(random()*legal.length)].point;}
    assert.deepEqual(a.point,expected,'Rollout policy/seed mismatch');apply(a);actions++;
   }
   assert.equal(e.gameOver,true);assert.equal(r.terminal,true);assert.ok(r.actions.length<=c.rolloutMaximumPlies);
   GameEngine.prototype._updateTerritories.call(e);const area={BLACK:e.cachedTerritories.BLACK.area,WHITE:e.cachedTerritories.WHITE.area};assert.deepEqual(r.scores,area);
   const other=ep.player==='BLACK'?'WHITE':'BLACK',reward=area[ep.player]===area[other]?0.5:Number(area[ep.player]>area[other]);assert.equal(r.reward,reward);scores[r.actionIndex].push(reward);rollouts++;units++;
  }
  const e=new GameEngine({gridSize:ep.size,playerCount:2,startPlayer:ep.start,rulesVersion:'territory-v2'});e._isReplayingBatch=true;for(const a of ep.actions)assert.ok((a.point===null?e.skipTurn():e.playMove(a.point)).success);
  const encoded=encodeResearchPosition(e),sample=ep.samples[0];assert.equal(ep.samples.length,1);assert.equal(sample.ply,ep.actions.length);assert.equal(sample.player,e.currentPlayer);
  assert.deepEqual(sample.features,[...encoded.features]);assert.deepEqual(sample.legal,encoded.legal);assert.deepEqual(sample.relations,researchRelations(e,e.currentPlayer,true));assert.deepEqual(sample.modelFreeState,modelFreeState(e));
  const q=scores.map(s=>s.reduce((a,b)=>a+b,0)/s.length);assert.deepEqual(sample.teacherActionMeans,q);
  const exps=q.map(v=>Math.exp((v-Math.max(...q))/c.targetTemperature)),denom=exps.reduce((a,b)=>a+b,0),target=Array(e.validPositions.length).fill(0);
  for(const idx of encoded.legal)target[idx]=c.uniformTargetMix/encoded.legal.length;
  ep.candidates.forEach((point,k)=>target[e._keyToIdx.get(point.join(','))]+=(1-c.uniformTargetMix)*exps[k]/denom);
  assert.deepEqual(sample.target,target);units++;
  await durable(proofPath,sealed({identity:proofIdentity,id:plan.id,game_sha256:ref.sha256,rollouts:rollouts-oldRollouts,actions:actions-oldActions}));
  await read(proofPath);done++;await progress('RUNNING');
 }
 assert.equal(cp.units,units);assert.equal(dataProgress.progress_units,units);for(const [p,h] of hashes)assert.equal(sha(await readFile(p)),h,'Evidence changed during verification');
 await progress('COMPLETE');
 return {status:'PASS_TERMINAL_ROLLOUT_DATA_R3',identity:identity.identity,positions:plans.length,rollouts,rolloutActions:actions,
  trainSamples:plans.filter(p=>p.split==='train').length,validationSamples:plans.filter(p=>p.split==='validation').length,
  manifest_sha256:sha(await readFile(resolve(run,'manifest.json'))),verifier_sha256:sha(await readFile(fileURLToPath(import.meta.url))),
  scope:'All terminal rollout actions/behavior seeds, rule transitions, discrete area rewards, position encodings and target probabilities; shortlist uses existing frozen Web inference.',input_hashes:Object.fromEntries(hashes)};
 }finally{await new Promise(r=>guard.close(r));}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{const args=process.argv.slice(2),opt=(n,d)=>{const i=args.indexOf(n);return i<0?d:args[i+1];},run=resolve(opt('--run-root')),output=resolve(opt('--output'));assert.ok(args.includes('--run-root')&&args.includes('--output'));const r=await verifyData(run,resolve(opt('--verify-root',resolve(run,'verification-work'))),Number(opt('--max-seconds','250')));if(r){await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify({status:r.status,positions:r.positions,rollouts:r.rollouts,rolloutActions:r.rolloutActions}));}else process.exitCode=75;}catch(e){console.error(e.stack);process.exitCode=e.code==='EADDRINUSE'?76:78;}}
