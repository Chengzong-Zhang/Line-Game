import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameEngine } from '../GameEngine.js';
import { EXPECTED_GATE, ORIGINAL_MANIFEST_SHA256, assertFrozenProtocol, assertCandidateProvenance, exactSignTest, holmStepDown, stratifiedBootstrap, expectedPlans, reconstruct, assessConfirmation } from '../../tools/assess-neural-confirmation.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),sha=(x)=>createHash('sha256').update(x).digest('hex');
const base=resolve(root,`local_artifacts/neural-confirmation-assessment-tests-${Date.now()}`);
await mkdir(base,{recursive:true});
const cases=[];
const config={schema:'lifeline-web-neural-screen-v1',evidenceTier:'FRESH_PAIRED_CONFIRMATION_WITH_EXTERNAL_HOLM_GATE',autoPromote:false,sizes:[5,7,9],prefixesPerSize:10,
  prefixPlies:4,maximumPlies:400,maximumGameMs:120000,puctSimulations:16,seedNamespace:'ai-improvement-round2-20261021-neural-confirmation-FINAL-v1',confirmation_gate:{...EXPECTED_GATE}};
const candidates=Array.from({length:7},(_,i)=>({id:`fixture-model-${i}`,parent_model_id:`fixture-parent-${i}`}));
const plans=expectedPlans(candidates,config);
const clone=(value)=>structuredClone(value);
assertFrozenProtocol(config);
for(const [key,value] of [['seedNamespace','different'],['prefixPlies',3],['maximumPlies',399],['maximumGameMs',120001],['puctSimulations',15]]){
  const wrong=clone(config);wrong[key]=value;assert.throws(()=>assertFrozenProtocol(wrong),/Frozen protocol mismatch/);
}
cases.push('frozen-protocol-namespace-prefix-game-bounds-and-inference-budget');
function terminalGame(plan,score=0.5){
  const scores=score===0.5?{BLACK:2,WHITE:2}:score===(plan.candidateSeat==='BLACK'?1:0)?{BLACK:3,WHITE:1}:{BLACK:1,WHITE:3};
  const leaders=scores.BLACK===scores.WHITE?['BLACK','WHITE']:[scores.BLACK>scores.WHITE?'BLACK':'WHITE'];
  return {...plan,actions:[],prefixLength:0,activityMs:0,terminal:true,truncated:false,outcome:{scores,leaders,candidateScore:score}};
}
function syntheticGames(){return plans.map(p=>terminalGame(p,p.modelId===candidates[0].id?1:0.5));}

for(let n=0;n<=12;n++)for(let positive=0;positive<=n;positive++){
  let count=0;
  for(let bits=0;bits<2**n;bits++){let ones=0;for(let j=0;j<n;j++)ones+=(bits>>j)&1;if(ones>=positive)count++;}
  const exact=exactSignTest(positive,n-positive);
  assert.equal(exact.pValue,count/2**n);assert.equal(BigInt(exact.exactNumerator),BigInt(count));
}
assert.equal(exactSignTest(30,0).pValue,2**-30);assert.equal(exactSignTest(0,30).pValue,1);
assert.equal(exactSignTest(0,0).pValue,1);assert.equal(exactSignTest(1,0).pValue,0.5);
assert.throws(()=>exactSignTest(-1,1));cases.push('exact-sign-tail-exhaustive-enumeration-n0-through12-and-endpoints');

const boundary=holmStepDown(Array.from({length:7},(_,i)=>({id:String(i),pValue:i?1:0.05/7})),0.05);
assert.equal(boundary[0].rejected,true);assert.equal(boundary.slice(1).some(r=>r.rejected),false);
assert.equal(holmStepDown(Array.from({length:7},(_,i)=>({id:String(i),pValue:0.008})),0.05).some(r=>r.rejected),false);
const mixed=holmStepDown([{id:'a',pValue:0.001},{id:'b',pValue:0.01},{id:'c',pValue:0.04}],0.05);
assert.deepEqual(mixed.map(r=>r.rejected),[true,true,true]);
assert.deepEqual(mixed.map(r=>r.adjustedP),[0.003,0.02,0.04]);
assert.throws(()=>holmStepDown([{id:'a',pValue:0.1},{id:'a',pValue:0.2}],0.05));
cases.push('Holm-inclusive-boundary-step-down-stop-adjustment-and-duplicate-family');

assert.deepEqual(stratifiedBootstrap([[0.5],[0.5],[0.5]],100,3).low,0.5);
const constantBySize=stratifiedBootstrap([[-0.5,-0.5],[0,0],[0.5,0.5]],100,3);
assert.equal(constantBySize.low,0);assert.equal(constantBySize.high,0);
assert.deepEqual(stratifiedBootstrap([[0,0.5],[0.25,-0.25]],100,42),stratifiedBootstrap([[0,0.5],[0.25,-0.25]],100,42));
cases.push('bootstrap-fixed-seed-size-stratification-and-degenerate-endpoints');

const complete=reconstruct(syntheticGames(),candidates,config);
assert.equal(complete.statisticalRows[0].promotionPass,true);
assert.equal(complete.statisticalRows[0].signTest.nonTied,30);
assert.equal(complete.statisticalRows[1].signTest.ties,30);assert.equal(complete.statisticalRows[1].holmInputP,1);
for(const mutate of [
  g=>g.pop(),g=>{g[1]=clone(g[0]);},g=>{g[1].seed++;},g=>{g[1].start='WHITE';},
  g=>{g[1].actions=[{player:'BLACK',point:[0,0]}];g[1].prefixLength=1;},
]){const games=syntheticGames();mutate(games);assert.throws(()=>reconstruct(games,candidates,config));}
const truncated=syntheticGames();Object.assign(truncated[0],{terminal:false,truncated:true,outcome:null});
const rejected=reconstruct(truncated,candidates,config).statisticalRows[0];
assert.equal(rejected.promotionPass,false);assert.equal(rejected.holmInputP,1);assert.equal(rejected.signTest,null);assert.equal(rejected.bootstrap,null);
const perSize=syntheticGames();for(const game of perSize)if(game.modelId===candidates[0].id&&game.size===5)Object.assign(game,terminalGame(game,0));
assert.equal(reconstruct(perSize,candidates,config).statisticalRows[0].criteria.everySizeFloor,false);
cases.push('paired-plan-missing-duplicate-seed-start-prefix-rejection-and-truncation-no-promotion');

// Full file contract fixture: real seeded legal histories and fresh terminal
// areas, with a synthetic upstream-verifier receipt. It is not a model-strength
// or actual upstream policy-replay result.
const oldManifestPath=resolve(root,'local_artifacts/all-ai-posttraining-20261021/neural-training/candidate-manifest.json');
const oldManifest=JSON.parse(await readFile(oldManifestPath,'utf8'));
const wanted=['padded-cnn-transfer-v1-seed2026092203','grid-gnn-transfer-v1-seed2026092201',
  'grid-gnn-transfer-v1-seed2026092202','grid-gnn-transfer-v1-seed2026092203','dqn-all-sizes-e2000','sac-all-sizes-e2000','gail-all-sizes'];
const actualCandidates=wanted.map(id=>{const m=oldManifest.models.find(m=>m.parent_model_id===id);assert.ok(m);return {...m,asset:resolve(dirname(oldManifestPath),m.asset)};});
const run=resolve(base,'arena');await mkdir(resolve(run,'games'),{recursive:true});
const jsonWrite=async(path,value)=>writeFile(path,JSON.stringify(value)+'\n');
const candidatePath=resolve(base,'candidates.json'),configPath=resolve(base,'config.json');
const subsetManifest={source_manifest:oldManifestPath,source_manifest_sha256:ORIGINAL_MANIFEST_SHA256,models:actualCandidates};
const originalHash=sha(await readFile(oldManifestPath));
assertCandidateProvenance(subsetManifest,oldManifest,originalHash,candidatePath,oldManifestPath);
for(const mutate of [m=>m.models[0].id='substituted',m=>m.models.reverse(),m=>m.source_manifest_sha256='0'.repeat(64),m=>m.models[0].asset_sha256='0'.repeat(64)]){
  const wrong=clone(subsetManifest);mutate(wrong);assert.throws(()=>assertCandidateProvenance(wrong,oldManifest,originalHash,candidatePath,oldManifestPath));
}
assert.throws(()=>assertCandidateProvenance(subsetManifest,oldManifest,'0'.repeat(64),candidatePath,oldManifestPath),/Original manifest bytes changed/);
cases.push('fixed-candidate-family-order-origin-hash-and-normalized-spec-provenance');
await jsonWrite(candidatePath,subsetManifest);await jsonWrite(configPath,config);
const source_hashes={};
const bind=async(path)=>{source_hashes[path]=sha(await readFile(resolve(root,path)));};
for(const p of ['web/tools/neural-posttraining-arena-v2.mjs','web/tools/neural-posttraining-data.mjs','web/web前端/GameEngine.js',
  'web/web前端/AIEngine.js','web/web前端/ResearchAI.js','web/web前端/ModelFreeAI.js',candidatePath,configPath])await bind(p);
const parentRoot=resolve(root,'web/web前端/assets/research-ai'),parents=[];
for(const name of ['manifest.json','transfer-v1/manifest.json','model-free-manifest.json']){
  const path=resolve(parentRoot,name);await bind(path);parents.push(...JSON.parse(await readFile(path,'utf8')).models);
}
for(const candidate of actualCandidates){await bind(candidate.asset);const parent=parents.find(m=>m.id===candidate.parent_model_id);await bind(resolve(parentRoot,parent.asset));}
const identity={identity:sha(JSON.stringify(source_hashes)),source_hashes,config,plannedGames:420,
  candidateManifestPath:candidatePath,configPath,parentManifestRoot:parentRoot};
await jsonWrite(resolve(run,'identity.json'),identity);
const realPlans=expectedPlans(actualCandidates,config),realGames=[],completed=[],cache=new Map();
let units=0,actions=0,sampled=0;
for(const plan of realPlans){
  let replay=cache.get(plan.cluster);
  if(!replay){
    const e=new GameEngine({gridSize:plan.size,playerCount:2,startPlayer:plan.start,rulesVersion:'territory-v2'});e._isReplayingBatch=true;
    let state=plan.seed;const rng=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
    const history=[];
    while(!e.gameOver&&history.length<400){const legal=e.getLegalMoves(e.currentPlayer),point=legal.length?legal[Math.floor(rng()*legal.length)].point:null;
      const player=e.currentPlayer;assert.ok((point===null?e.skipTurn():e.playMove(point)).success);history.push({player,point});}
    assert.equal(e.gameOver,true);GameEngine.prototype._updateTerritories.call(e);
    replay={actions:history,prefixLength:Math.min(4,history.length),scores:{BLACK:e.cachedTerritories.BLACK.area,WHITE:e.cachedTerritories.WHITE.area}};cache.set(plan.cluster,replay);
  }
  const game={...plan,...clone(replay),activityMs:0,terminal:true,truncated:false};delete game.scores;
  for(let i=game.prefixLength;i<game.actions.length;i++)game.actions[i].modelId=game.actions[i].player===plan.candidateSeat?plan.modelId:plan.parentId;
  const scores=replay.scores,leaders=scores.BLACK===scores.WHITE?['BLACK','WHITE']:[scores.BLACK>scores.WHITE?'BLACK':'WHITE'];
  game.outcome={scores,leaders,candidateScore:leaders.includes(plan.candidateSeat)?1/leaders.length:0};
  const path=`games/${plan.id}.json`;await jsonWrite(resolve(run,path),game);completed.push({path,sha256:sha(await readFile(resolve(run,path)))});
  realGames.push(game);units+=game.actions.length-game.prefixLength+1;actions+=game.actions.length;
  sampled+=new Set([game.prefixLength,Math.floor((game.prefixLength+game.actions.length)/2)].filter(i=>i<game.actions.length)).size;
}
const reconstructed=reconstruct(realGames,actualCandidates,config);
const summary={identity:identity.identity,status:'COMPLETE_APPLICATION_SCREEN',promotionPass:false,
  decision:'Retain shipped defaults. This small paired screen is not a release gate or a multiplicity-adjusted strength confirmation.',
  terminalGames:420,truncatedGames:0,models:reconstructed.summaryRows};
await jsonWrite(resolve(run,'summary.json'),summary);
const cp={identity:identity.identity,units,completed,current:null};
await jsonWrite(resolve(run,'checkpoint.json'),{...cp,integrity:sha(JSON.stringify(cp))});
await jsonWrite(resolve(run,'progress.json'),{identity:identity.identity,status:'COMPLETE',progress_units:units});
const verifierPath=resolve(root,'web/tools/verify-neural-posttraining-v2.mjs'),adapterPath=resolve(root,'web/tools/run-neural-arena-verification.mjs');
const verifierHash=sha(await readFile(verifierPath));
const verification={status:'PASS_APPLICATION_SCREEN_REPLAY',summaryFieldsVerified:'all',identity:identity.identity,
  verifier_sha256:verifierHash,promotionPass:false,games:420,terminalGames:420,truncatedGames:0,actions,sampledPolicyDecisions:sampled};
await jsonWrite(resolve(run,'verification.json'),verification);
const executionPath=resolve(base,'synthetic-verification-execution.json');
const execution={schema:'lifeline-supervised-verification-receipt-v1',verifier_exit_code:0,
  arena_identity:identity.identity,verifier_sha256:verifierHash,command:[process.execPath,verifierPath,'--arena-root',run,'--candidates',candidatePath],
  arena_summary_sha256:sha(await readFile(resolve(run,'summary.json'))),verification_sha256:sha(await readFile(resolve(run,'verification.json')))};
execution.identity=sha(JSON.stringify({arena:sha(await readFile(resolve(run,'identity.json'))),summary:execution.arena_summary_sha256,
  verifier:verifierHash,candidates:sha(await readFile(candidatePath)),adapter:sha(await readFile(adapterPath))}));
await jsonWrite(executionPath,execution);
const report=await assessConfirmation(run,executionPath);
assert.equal(report.games,420);assert.equal(report.eligibleModelIds.length,0);assert.equal(report.verificationScope.policyDecisionsRecomputedHere,0);
cases.push('full-file-contract-420-real-legal-histories-with-synthetic-upstream-receipt');

async function mutateReject(path,mutate,pattern){const bytes=await readFile(path);try{const value=JSON.parse(bytes);mutate(value);await jsonWrite(path,value);await assert.rejects(assessConfirmation(run,executionPath),pattern);}finally{await writeFile(path,bytes);}}
await mutateReject(resolve(run,'verification.json'),v=>v.status='INCOMPLETE');
await mutateReject(executionPath,v=>v.verifier_exit_code=1);
await mutateReject(resolve(run,'summary.json'),v=>v.models[0].wins++);
await mutateReject(configPath,v=>v.confirmation_gate.minimumMeanScore=0.4,/Input drift/);
await mutateReject(resolve(run,completed[0].path),v=>v.outcome.scores.BLACK++,/Game bytes changed/);
const gamePath=resolve(run,completed[0].path),checkpointPath=resolve(run,'checkpoint.json');
const originalGame=await readFile(gamePath),originalCheckpoint=await readFile(checkpointPath);
try{
  const game=JSON.parse(originalGame);game.outcome.scores.BLACK++;
  await jsonWrite(gamePath,game);const altered=clone(cp);altered.completed[0].sha256=sha(await readFile(gamePath));
  await jsonWrite(checkpointPath,{...altered,integrity:sha(JSON.stringify(altered))});
  await assert.rejects(assessConfirmation(run,executionPath),/Fresh area mismatch/);
}finally{await writeFile(gamePath,originalGame);await writeFile(checkpointPath,originalCheckpoint);}
cases.push('missing-verifier-pass-exit-failure-summary-config-game-byte-and-resealed-area-tamper-rejected');
const sources=['web/tools/assess-neural-confirmation.mjs','web/web前端/tests/verify-neural-confirmation-assessment.mjs'];
const receipt={status:'PASS_NEURAL_CONFIRMATION_ASSESSMENT_TESTS',cases,
  source_hashes:Object.fromEntries(await Promise.all(sources.map(async p=>[p,sha(await readFile(resolve(root,p)))]))),
  realLegalityFixtureGames:420,upstreamReceiptIsSyntheticInFixture:true,
  limitations:'Mathematical and input-contract tests, not confirmation games or actual model-policy evaluation.',
  command:'node --unhandled-rejections=strict web/web前端/tests/verify-neural-confirmation-assessment.mjs'};
await jsonWrite(resolve(base,'receipt.json'),receipt);console.log(JSON.stringify({...receipt,run:base}));
