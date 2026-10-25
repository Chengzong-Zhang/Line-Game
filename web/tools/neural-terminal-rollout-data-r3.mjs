import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,rename,open} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {GameEngine} from '../web前端/GameEngine.js';
import {GreedyAI} from '../web前端/AIEngine.js';
import {createResearchModel,encodeResearchPosition,researchRelations} from '../web前端/ResearchAI.js';
import {root,sha,rng,replay,modelFreeState,lease,sealed,unseal,readJson} from './neural-posttraining-data.mjs';

export const SOURCES=['web/tools/neural-terminal-rollout-data-r3.mjs','web/tools/neural-posttraining-data.mjs',
 'web/web前端/GameEngine.js','web/web前端/AIEngine.js','web/web前端/ResearchAI.js','web/web前端/AIStateProtocol.js'];
export async function durable(path,value){
 await mkdir(dirname(path),{recursive:true});const tmp=`${path}.${process.pid}.tmp`,f=await open(tmp,'w');
 try{await f.writeFile(JSON.stringify(value)+'\n');await f.sync();}finally{await f.close();}
 for(let i=0;;i++){try{await rename(tmp,path);break;}catch(e){if(i===7||!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;await new Promise(r=>setTimeout(r,15*(i+1)));}}
}
export function validate(config){
 assert.equal(config.schema,'lifeline-neural-terminal-headonly-r3-v1');assert.equal(config.rulesVersion,'territory-v2');
 assert.ok(config.sizes.every(n=>[5,7,9].includes(n))&&new Set(config.sizes).size===config.sizes.length);
 for(const k of ['trainPositionsPerSize','validationPositionsPerSize','candidateActions','rolloutsPerAction','rolloutMaximumPlies','prefixMinimum','prefixVariants'])assert.ok(Number.isSafeInteger(config[k])&&config[k]>0,k);
 assert.ok(config.candidateActions<=4&&config.rolloutsPerAction<=2&&config.rolloutMaximumPlies<=400);
 assert.ok(config.targetTemperature>0&&config.uniformTargetMix>0&&config.uniformTargetMix<1);
 assert.equal(config.rolloutGreedyProbability,0.5);assert.equal(config.model_ids.length,2);
}
export function plansFor(c){const p=[];for(const size of c.sizes)for(const split of ['train','validation'])for(let i=0;i<c[split==='train'?'trainPositionsPerSize':'validationPositionsPerSize'];i++){
 const id=`n${size}-${split}-${i}`;p.push({id,size,split,index:i,start:i%2?'WHITE':'BLACK',seed:parseInt(sha(`${c.seedNamespace}/${id}`).slice(0,8),16)});
}return p;}
export async function loadWarm(c){
 const path=resolve(root,c.warmstart_manifest),bytes=await readFile(path);assert.equal(sha(bytes),c.warmstart_manifest_sha256);
 const all=JSON.parse(bytes).models,models=[],specs=[],hashes={[path]:sha(bytes)};
 for(const id of c.model_ids){const spec=all.find(s=>s.id===id);assert.ok(spec?.model_kind,'Research models only');
  const asset=resolve(dirname(path),spec.asset),raw=await readFile(asset);assert.equal(sha(raw),spec.asset_sha256);hashes[asset]=sha(raw);
  models.push(createResearchModel(spec,raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength)));specs.push(spec);}
 return {models,specs,hashes};
}
function neuralPoint(model,e){const z=model.evaluate(e),legal=e.getLegalMoves(e.currentPlayer);return legal.sort((a,b)=>z.pointScores[e._keyToIdx.get(b.point.join(','))]-z.pointScores[e._keyToIdx.get(a.point.join(','))]||a.point[1]-b.point[1]||a.point[0]-b.point[0])[0]?.point??null;}
function move(e,point,actions){const player=e.currentPlayer;assert.ok((point===null?e.skipTurn():e.playMove(point)).success);actions.push({player,point:point&&[...point]});}
export function makePosition(plan,c,models){
 const e=replay({...plan,actions:[]}),random=rng(plan.seed),actions=[];
 const length=c.prefixMinimum+2*(plan.index%c.prefixVariants);
 for(let ply=0;ply<length&&!e.gameOver;ply++){
  const legal=e.getLegalMoves(e.currentPlayer);if(!legal.length)break;
  const choice=Math.floor(random.next()*4),point=choice<2?neuralPoint(models[choice],e):choice===2?new GreedyAI().getTopMoves(e,e.currentPlayer,1)[0].point:legal[Math.floor(random.next()*legal.length)].point;
  move(e,point,actions);if(e.gameOver){actions.pop();break;}
 }
 const position=replay({...plan,actions}),legal=position.getLegalMoves(position.currentPlayer),selected=[];
 assert.ok(!position.gameOver&&legal.length,'No trainable position');
 const push=p=>{if(p&&!selected.some(q=>q.join(',')===p.join(',')))selected.push([...p]);};
 for(const model of models)push(neuralPoint(model,position));
 push(new GreedyAI().getTopMoves(position,position.currentPlayer,1)[0]?.point);
 const shuffled=[...legal];while(selected.length<Math.min(c.candidateActions,legal.length)&&shuffled.length){const i=Math.floor(random.next()*shuffled.length);push(shuffled.splice(i,1)[0].point);}
 return {...plan,actions,candidates:selected.slice(0,c.candidateActions),player:position.currentPlayer,rollouts:[]};
}
export function rollout(position,c,actionIndex,repeat){
 const seed=parseInt(sha(`${c.seedNamespace}/${position.id}/rollout/${repeat}`).slice(0,8),16),random=rng(seed);
 const e=replay(position),actions=[];move(e,position.candidates[actionIndex],actions);
 while(!e.gameOver&&actions.length<c.rolloutMaximumPlies){
  const legal=e.getLegalMoves(e.currentPlayer);let point=null;
  if(legal.length)point=random.next()<c.rolloutGreedyProbability?new GreedyAI().getTopMoves(e,e.currentPlayer,1)[0].point:legal[Math.floor(random.next()*legal.length)].point;
  move(e,point,actions);
 }
 assert.equal(e.gameOver,true,'Truncated teacher rollout; no target may be emitted');
 GameEngine.prototype._updateTerritories.call(e);
 const scores={BLACK:e.cachedTerritories.BLACK.area,WHITE:e.cachedTerritories.WHITE.area},other=position.player==='BLACK'?'WHITE':'BLACK';
 return {actionIndex,repeat,seed,actions,terminal:true,scores,reward:scores[position.player]>scores[other]?1:scores[position.player]===scores[other]?0.5:0};
}
export function sampleFor(position,c){
 const e=replay(position),encoded=encodeResearchPosition(e),q=position.candidates.map((_,i)=>position.rollouts.filter(r=>r.actionIndex===i).reduce((s,r)=>s+r.reward,0)/c.rolloutsPerAction);
 assert.equal(position.rollouts.length,position.candidates.length*c.rolloutsPerAction);
 const maximum=Math.max(...q),exps=q.map(x=>Math.exp((x-maximum)/c.targetTemperature)),sum=exps.reduce((a,b)=>a+b,0),target=Array(e.validPositions.length).fill(0);
 for(const i of encoded.legal)target[i]=c.uniformTargetMix/encoded.legal.length;
 position.candidates.forEach((point,i)=>target[e._keyToIdx.get(point.join(','))]+=(1-c.uniformTargetMix)*exps[i]/sum);
 return {ply:position.actions.length,player:e.currentPlayer,features:[...encoded.features],relations:researchRelations(e,e.currentPlayer,true),legal:encoded.legal,target,modelFreeState:modelFreeState(e),teacherActionMeans:q};
}
export async function dataMain(args){
 throw new Error('Historical rollout-only labels are retired. New training requires defensive-training-data-v1.mjs, complete minimax depth >=3 and two actual opponent rounds.');
 const opt=(n,d)=>{const i=args.indexOf(n);return i<0?d:args[i+1];},run=resolve(root,opt('--run-root','local_artifacts/neural-terminal-headonly-r3-20261021/data')),
 configPath=resolve(root,opt('--config','web/tools/configs/neural-terminal-headonly-r3-20261021.json')),maxSeconds=Number(opt('--max-seconds','250')),maxUnits=Number(opt('--max-new-units','1000000')),fault=opt('--fault','');
 assert.ok(maxSeconds>0&&maxSeconds<=1200&&maxUnits>=0);await mkdir(run,{recursive:true});const guard=await lease(run);
 let cp,identity;const started=Date.now();let fresh=0;
 const progress=async status=>{await durable(resolve(run,'checkpoint.json'),sealed(cp));await durable(resolve(run,'progress.json'),{status,identity,progress_units:cp.units,completed_positions:cp.completed.length});};
 try{
  const raw=await readFile(configPath),c=JSON.parse(raw);validate(c);assert.ok(!fault||c.recoveryTest===true);
  const warm=await loadWarm(c),source_hashes={};for(const p of SOURCES)source_hashes[p]=sha(await readFile(resolve(root,p)));
  const binding={...warm.hashes,[configPath]:sha(raw)};identity=sha(JSON.stringify({source_hashes,binding}));const plans=plansFor(c);
  const old=await readJson(resolve(run,'checkpoint.json'),true);cp=old?unseal(old):{identity,units:0,completed:[],current:null};assert.equal(cp.identity,identity,'Source/input drift');
  for(const [i,ref] of cp.completed.entries()){assert.equal(ref.id,plans[i].id);assert.equal(sha(await readFile(resolve(run,ref.path))),ref.sha256,'Completed position corruption');}
  for(const dir of [run,resolve(run,'episodes')]){await mkdir(dir,{recursive:true});for(const name of await readdir(dir))if(name.endsWith('.tmp')){await mkdir(resolve(run,'interrupted'),{recursive:true});await rename(resolve(dir,name),resolve(run,'interrupted',`${Date.now()}-${name}`));}}
  await durable(resolve(run,'identity.json'),{identity,source_hashes,binding,config:c});
  while(cp.completed.length<plans.length){
   for(const [name,status] of [['STOP','STOPPED'],['PAUSE','PAUSED']])if(await readJsonMarker(resolve(run,name))){await progress(status);return 75;}
   if(Date.now()-started>=maxSeconds*1000||fresh>=maxUnits){await progress('YIELDED');return 75;}
   if(!cp.current){cp.current=makePosition(plans[cp.completed.length],c,warm.models);await progress('RUNNING');}
   const p=cp.current,count=p.candidates.length*c.rolloutsPerAction;
   if(p.rollouts.length<count){const n=p.rollouts.length;p.rollouts.push(rollout(p,c,Math.floor(n/c.rolloutsPerAction),n%c.rolloutsPerAction));cp.units++;fresh++;await progress('RUNNING');if(fault==='after-rollout')process.exit(91);if(c.test_delay_ms)await new Promise(r=>setTimeout(r,c.test_delay_ms));continue;}
   const ep={...p,samples:[sampleFor(p,c)],terminal:false,truncated:false,positionOnly:true,datasetIdentity:identity,rulesVersion:'territory-v2'},path=`episodes/${p.id}.json`,expected=Buffer.from(JSON.stringify(ep)+'\n');
   let present;try{present=await readFile(resolve(run,path));}catch(e){if(e.code!=='ENOENT')throw e;}
   if(present)assert.ok(present.equals(expected),'Unindexed position differs');else await durable(resolve(run,path),ep);
   if(fault==='after-position')process.exit(92);
   cp.completed.push({id:p.id,size:p.size,start:p.start,split:p.split,path,sha256:sha(expected),samples:1});cp.current=null;cp.units++;fresh++;await progress('RUNNING');
  }
  for(const [p,h] of Object.entries({...source_hashes,...binding}))assert.equal(sha(await readFile(resolve(root,p))),h,'Frozen input drift');
  await durable(resolve(run,'manifest.json'),{schema:'lifeline-web-distillation-dataset-v1',rulesVersion:'territory-v2',identity,episodes:cp.completed,source_hashes,config_sha256:sha(raw),
   teacher:'Paired exact terminal rollout scores, 50% Greedy / 50% uniform, 2 rollouts/action; finite shortlisted actions only.',warmstart_hashes:warm.hashes});
  await progress('COMPLETE');return 0;
 }catch(e){if(cp)await progress('FATAL');throw e;}finally{await new Promise(r=>guard.close(r));}
}
async function readJsonMarker(path){try{await readFile(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{process.exitCode=await dataMain(process.argv.slice(2));}catch(e){console.error(e.stack);process.exitCode=e.code==='EADDRINUSE'?76:78;}}
