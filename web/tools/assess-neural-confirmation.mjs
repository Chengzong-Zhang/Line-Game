// A frozen, independent statistical gate over already verified application games.
// No model fitting, checkpoint selection, deployment, or mutation of arena summary.
import assert from 'node:assert/strict';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameEngine } from '../web前端/GameEngine.js';

const SELF=fileURLToPath(import.meta.url), ROOT=resolve(dirname(SELF),'../..');
const VERIFIER='web/tools/verify-neural-posttraining-v2.mjs';
const ADAPTER='web/tools/run-neural-arena-verification.mjs';
const sha=(bytes)=>createHash('sha256').update(bytes).digest('hex');
const readJSON=async(path)=>JSON.parse(await readFile(path,'utf8'));
export const EXPECTED_GATE=Object.freeze({schema:'lifeline-neural-confirmation-gate-v1',familySize:7,
  gamesPerModel:60,clustersPerModel:30,minimumMeanScore:0.55,minimumPerSizeScore:0.45,
  signTest:'one-sided-exact-binomial-non-tied-cluster-sign',holmAlpha:0.05,
  bootstrapReplicates:10000,bootstrapSeed:2026102137,bootstrapStratifyBy:'size'});
export const ORIGINAL_MANIFEST_SHA256='69c6f45209f08c9acef9cb0b1a01264185e8a711789428dac362b4b3812a9545';
export const EXPECTED_CANDIDATES=Object.freeze([
  'padded-cnn-transfer-v1-seed2026092203-distill-v1',
  'grid-gnn-transfer-v1-seed2026092201-distill-v1','grid-gnn-transfer-v1-seed2026092202-distill-v1',
  'grid-gnn-transfer-v1-seed2026092203-distill-v1','dqn-all-sizes-e2000-distill-v1',
  'sac-all-sizes-e2000-distill-v1','gail-all-sizes-distill-v1']);
export function assertFrozenProtocol(config){
  assert.deepEqual(config.confirmation_gate,EXPECTED_GATE,'Confirmation gate differs from predeclared protocol');
  const fixed={schema:'lifeline-web-neural-screen-v1',evidenceTier:'FRESH_PAIRED_CONFIRMATION_WITH_EXTERNAL_HOLM_GATE',
    sizes:[5,7,9],prefixesPerSize:10,autoPromote:false,puctSimulations:16,prefixPlies:4,
    maximumPlies:400,maximumGameMs:120000,seedNamespace:'ai-improvement-round2-20261021-neural-confirmation-FINAL-v1'};
  for(const [key,value] of Object.entries(fixed))assert.deepEqual(config[key],value,`Frozen protocol mismatch: ${key}`);
}
export function assertCandidateProvenance(manifest,source,sourceHash,manifestPath,sourcePath){
  assert.equal(manifest.source_manifest_sha256,ORIGINAL_MANIFEST_SHA256,'Wrong original manifest declaration');
  assert.equal(sourceHash,ORIGINAL_MANIFEST_SHA256,'Original manifest bytes changed');
  assert.deepEqual(manifest.models.map(m=>m.id),EXPECTED_CANDIDATES,'Frozen candidate family/order mismatch');
  for(const candidate of manifest.models){
    const originals=source.models.filter(m=>m.id===candidate.id);assert.equal(originals.length,1,'Missing or duplicate original model');
    const normalize=(model,path)=>({...model,asset:resolve(dirname(path),model.asset)});
    assert.deepEqual(normalize(candidate,manifestPath),normalize(originals[0],sourcePath),'Candidate differs from frozen original');
  }
}
function unseal(value){const {integrity,...body}=value;assert.equal(integrity,sha(JSON.stringify(body)),'Checkpoint integrity');return body;}
function inside(base,path){const full=resolve(base,path), rel=relative(base,full);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'Evidence path escapes run root');return full;}
function random(seed){let state=seed>>>0;return()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};}
function average(values){return values.reduce((a,b)=>a+b,0)/values.length;}

// Binomial boundary tail for independent nonzero cluster signs. Under each
// size-specific P(positive | nonzero,size)<=1/2 the tail is conservative;
// it is exact when every retained sign has boundary probability 1/2.
// This is not a test of the mean score or of the mean score difference.
export function exactSignTest(positive,negative){
  assert.ok(Number.isInteger(positive)&&Number.isInteger(negative)&&positive>=0&&negative>=0);
  const n=positive+negative;assert.ok(n<=60,'Exact kernel supports at most 60 non-tied clusters');
  let coefficient=1n,numerator=0n;
  for(let k=0;k<=n;k++){
    if(k>=positive)numerator+=coefficient;
    if(k<n)coefficient=coefficient*BigInt(n-k)/BigInt(k+1);
  }
  const denominator=1n<<BigInt(n);
  return {positive,negative,nonTied:n,pValue:Number(numerator)/Number(denominator),
    exactNumerator:String(numerator),exactDenominator:String(denominator)};
}

export function holmStepDown(records,alpha){
  assert.ok(alpha>0&&alpha<1);assert.equal(new Set(records.map(r=>r.id)).size,records.length);
  const ordered=records.map(r=>({...r})).sort((a,b)=>a.pValue-b.pValue||a.id.localeCompare(b.id));
  let continuing=true,previousAdjusted=0;
  for(let i=0;i<ordered.length;i++){
    const item=ordered[i];assert.ok(Number.isFinite(item.pValue)&&item.pValue>=0&&item.pValue<=1);
    item.rank=i+1;item.threshold=alpha/(ordered.length-i);
    item.adjustedP=Math.min(1,Math.max(previousAdjusted,(ordered.length-i)*item.pValue));
    previousAdjusted=item.adjustedP;
    item.rejected=continuing&&item.pValue<=item.threshold;
    continuing=item.rejected;
  }
  return ordered;
}

export function stratifiedBootstrap(strata,replicates,seed){
  assert.ok(Number.isSafeInteger(replicates)&&replicates>=1);
  assert.ok(strata.length&&strata.every(s=>s.length&&s.every(Number.isFinite)));
  const rng=random(seed), draws=[], count=strata.reduce((n,s)=>n+s.length,0);
  for(let i=0;i<replicates;i++){
    let sum=0;
    for(const stratum of strata)for(let j=0;j<stratum.length;j++)sum+=stratum[Math.floor(rng()*stratum.length)];
    draws.push(sum/count);
  }
  draws.sort((a,b)=>a-b);
  const percentile=(q)=>{const x=q*(draws.length-1),a=Math.floor(x),b=Math.ceil(x);return draws[a]+(draws[b]-draws[a])*(x-a);};
  return {low:percentile(0.025),high:percentile(0.975),replicates,seed:seed>>>0,
    method:'Percentile bootstrap of paired-opening mean-score differences, resampling clusters within size; linear percentile interpolation.',
    scope:'Descriptive 95% interval, not multiplicity-adjusted and not used as a promotion gate.'};
}

export function expectedPlans(candidates,config){
  const plans=[];
  for(const model of candidates)for(const size of config.sizes)for(let i=0;i<config.prefixesPerSize;i++){
    const cluster=`n${size}-p${i}`,seed=parseInt(sha(`${config.seedNamespace}/${cluster}`).slice(0,8),16);
    for(const candidateSeat of ['BLACK','WHITE'])plans.push({id:`${model.id}-${cluster}-${candidateSeat}`,
      modelId:model.id,parentId:model.parent_model_id,cluster,size,seed,start:i%2?'WHITE':'BLACK',candidateSeat});
  }
  return plans;
}

// Separate pure structural kernel supports deterministic adversarial fixtures.
export function reconstruct(games,candidates,config){
  const plans=expectedPlans(candidates,config);
  assert.equal(games.length,plans.length,'Missing planned games');
  const ids=new Set(), summaryRows=[], statisticalRows=[];
  for(let i=0;i<plans.length;i++){
    const game=games[i],plan=plans[i];
    assert.ok(!ids.has(game.id),'Duplicate game');ids.add(game.id);
    for(const [key,value] of Object.entries(plan))assert.deepEqual(game[key],value,`Pair plan mismatch: ${key}`);
    assert.equal(typeof game.terminal,'boolean');assert.equal(game.truncated,!game.terminal);
    if(game.terminal){
      const scores=game.outcome?.scores;assert.deepEqual(Object.keys(scores).sort(),['BLACK','WHITE']);
      assert.ok(Object.values(scores).every(v=>Number.isFinite(v)&&v>=0));
      const leaders=scores.BLACK===scores.WHITE?['BLACK','WHITE']:[scores.BLACK>scores.WHITE?'BLACK':'WHITE'];
      assert.deepEqual(game.outcome.leaders,leaders);
      assert.equal(game.outcome.candidateScore,leaders.includes(game.candidateSeat)?1/leaders.length:0,'Terminal outcome/score mismatch');
    }else assert.equal(game.outcome,null,'Truncated games cannot have an outcome');
  }
  for(const model of candidates){
    const rows=games.filter(g=>g.modelId===model.id),terminal=rows.filter(g=>g.terminal), scores=terminal.map(g=>g.outcome.candidateScore);
    const complete=terminal.length===rows.length,perSize={};
    for(const size of config.sizes){const items=rows.filter(g=>g.size===size);perSize[size]=items.every(g=>g.terminal)?average(items.map(g=>g.outcome.candidateScore)):null;}
    const meanScore=complete?average(scores):null;
    summaryRows.push({id:model.id,parent_model_id:model.parent_model_id,plannedGames:rows.length,
      terminalGames:terminal.length,truncatedGames:rows.length-terminal.length,
      wins:scores.filter(v=>v===1).length,draws:scores.filter(v=>v===0.5).length,losses:scores.filter(v=>v===0).length,meanScore,perSize});
    const clusters=[];
    for(const size of config.sizes)for(let i=0;i<config.prefixesPerSize;i++){
      const pair=rows.filter(g=>g.cluster===`n${size}-p${i}`);
      assert.equal(pair.length,2,'Missing paired seat');assert.deepEqual(pair.map(g=>g.candidateSeat).sort(),['BLACK','WHITE']);
      assert.equal(pair[0].seed,pair[1].seed,'Pair seed mismatch');assert.equal(pair[0].start,pair[1].start,'Pair start mismatch');
      assert.deepEqual(pair[0].actions?.slice(0,pair[0].prefixLength),pair[1].actions?.slice(0,pair[1].prefixLength),'Paired prefixes differ');
      clusters.push({cluster:pair[0].cluster,size,delta:pair.every(g=>g.terminal)?average(pair.map(g=>g.outcome.candidateScore))-0.5:null});
    }
    const values=clusters.map(c=>c.delta),positive=values.filter(v=>v!==null&&v>0).length,
      negative=values.filter(v=>v!==null&&v<0).length,ties=values.filter(v=>v===0).length;
    const sign=complete?{...exactSignTest(positive,negative),ties}:null;
    const seed=(config.confirmation_gate.bootstrapSeed^parseInt(sha(model.id).slice(0,8),16))>>>0;
    const bootstrap=complete?stratifiedBootstrap(config.sizes.map(size=>clusters.filter(c=>c.size===size).map(c=>c.delta)),
      config.confirmation_gate.bootstrapReplicates,seed):null;
    statisticalRows.push({id:model.id,parent_model_id:model.parent_model_id,plannedGames:rows.length,
      terminalGames:terminal.length,truncatedGames:rows.length-terminal.length,clusters:clusters.length,meanScore,perSize,
      meanScoreDelta:meanScore===null?null:meanScore-0.5,clusterSigns:{positive,negative,ties,missing:values.filter(v=>v===null).length},
      signTest:sign,holmInputP:sign?.pValue??1,bootstrap,
      criteria:{allNaturalTerminals:complete,meanScoreFloor:complete&&meanScore>=config.confirmation_gate.minimumMeanScore,
        everySizeFloor:complete&&Object.values(perSize).every(v=>v>=config.confirmation_gate.minimumPerSizeScore)}});
  }
  const holm=holmStepDown(statisticalRows.map(r=>({id:r.id,pValue:r.holmInputP})),config.confirmation_gate.holmAlpha);
  for(const row of statisticalRows){row.holm=holm.find(r=>r.id===row.id);row.criteria.holmRejected=row.holm.rejected;
    row.promotionPass=Object.values(row.criteria).every(Boolean);}
  return {summaryRows,statisticalRows,holm};
}

function replayAndCheck(game,config){
  const engine=new GameEngine({gridSize:game.size,playerCount:2,startPlayer:game.start,rulesVersion:'territory-v2'});
  engine._isReplayingBatch=true;
  const rng=random(game.seed),prefix=[];
  for(let i=0;i<config.prefixPlies&&!engine.gameOver;i++){
    const legal=engine.getLegalMoves(engine.currentPlayer),point=legal.length?legal[Math.floor(rng()*legal.length)].point:null;
    const player=engine.currentPlayer;
    assert.ok((point===null?engine.skipTurn():engine.playMove(point)).success);
    prefix.push({player,point});
  }
  assert.equal(game.prefixLength,prefix.length);assert.deepEqual(game.actions.slice(0,prefix.length),prefix,'Seeded prefix mismatch');
  let sampled=0;
  const indices=new Set([game.prefixLength,Math.floor((game.prefixLength+game.actions.length)/2)]);
  for(let i=prefix.length;i<game.actions.length;i++){
    const action=game.actions[i];assert.equal(engine.gameOver,false);assert.equal(action.player,engine.currentPlayer);
    assert.equal(action.modelId,action.player===game.candidateSeat?game.modelId:game.parentId);
    if(action.point===null)assert.equal(engine.getLegalMoves(engine.currentPlayer).length,0,'Unexpected voluntary PASS');
    assert.ok((action.point===null?engine.skipTurn():engine.playMove(action.point)).success,'Illegal game history');
    if(indices.has(i))sampled++;
  }
  assert.equal(game.terminal,engine.gameOver,'Terminal state mismatch');
  if(engine.gameOver){
    GameEngine.prototype._updateTerritories.call(engine);
    assert.deepEqual(game.outcome.scores,{BLACK:engine.cachedTerritories.BLACK.area,WHITE:engine.cachedTerritories.WHITE.area},'Fresh area mismatch');
  }else assert.ok(game.actions.length>=config.maximumPlies||game.activityMs>=config.maximumGameMs,'Unexplained truncation');
  return sampled;
}

export async function assessConfirmation(runRoot,executionPath){
  runRoot=resolve(runRoot);executionPath=resolve(executionPath);
  const observed=new Map();
  const observe=async(path)=>{path=resolve(path);const bytes=await readFile(path),hash=sha(bytes);
    if(observed.has(path))assert.equal(hash,observed.get(path),`Input changed across reads: ${path}`);
    observed.set(path,hash);return bytes;};
  const json=async(path)=>JSON.parse(await observe(path));
  await observe(SELF);
  const identity=await json(resolve(runRoot,'identity.json')),summary=await json(resolve(runRoot,'summary.json')),
    cp=unseal(await json(resolve(runRoot,'checkpoint.json'))),progress=await json(resolve(runRoot,'progress.json')),
    verification=await json(resolve(runRoot,'verification.json')),execution=await json(executionPath);
  assert.equal(identity.identity,sha(JSON.stringify(identity.source_hashes)));
  assert.equal(cp.identity,identity.identity);assert.equal(progress.identity,identity.identity);assert.equal(summary.identity,identity.identity);
  assert.equal(progress.status,'COMPLETE');assert.equal(cp.current,null);
  for(const [path,hash] of Object.entries(identity.source_hashes))assert.equal(sha(await observe(resolve(ROOT,path))),hash,`Input drift: ${path}`);
  for(const path of ['web/tools/neural-posttraining-arena-v2.mjs','web/tools/neural-posttraining-data.mjs',
    'web/web前端/GameEngine.js','web/web前端/AIEngine.js','web/web前端/ResearchAI.js','web/web前端/ModelFreeAI.js'])
    assert.equal(identity.source_hashes[path],sha(await observe(resolve(ROOT,path))),`Missing required source binding: ${path}`);
  const config=await json(identity.configPath);assert.deepEqual(config,identity.config);
  assertFrozenProtocol(config);
  assert.equal(identity.source_hashes[resolve(identity.configPath)],sha(await observe(identity.configPath)),'Missing config binding');
  assert.equal(identity.source_hashes['web/tools/neural-posttraining-arena-v2.mjs'],sha(await observe(resolve(ROOT,'web/tools/neural-posttraining-arena-v2.mjs'))));
  const manifest=await json(identity.candidateManifestPath),candidates=manifest.models;
  assert.equal(typeof manifest.source_manifest,'string','Missing source manifest path');
  const originalPath=resolve(dirname(identity.candidateManifestPath),manifest.source_manifest),originalBytes=await observe(originalPath);
  assertCandidateProvenance(manifest,JSON.parse(originalBytes),sha(originalBytes),identity.candidateManifestPath,originalPath);
  assert.equal(identity.source_hashes[resolve(identity.candidateManifestPath)],sha(await observe(identity.candidateManifestPath)));
  const parents=[];
  for(const name of ['manifest.json','transfer-v1/manifest.json','model-free-manifest.json']){
    const path=resolve(identity.parentManifestRoot,name),bytes=await observe(path);assert.equal(identity.source_hashes[path],sha(bytes));parents.push(...JSON.parse(bytes).models);
  }
  for(const candidate of candidates){
    const parent=parents.find(m=>m.id===candidate.parent_model_id);assert.ok(parent,'Unknown parent');
    for(const [model,base] of [[candidate,dirname(identity.candidateManifestPath)],[parent,resolve(ROOT,'web/web前端/assets/research-ai')]]){
      const path=resolve(base,model.asset),bytes=await observe(path);assert.equal(sha(bytes),model.asset_sha256);assert.equal(identity.source_hashes[path],sha(bytes));
    }
  }
  const verifierHash=sha(await observe(resolve(ROOT,VERIFIER)));
  assert.equal(verification.status,'PASS_APPLICATION_SCREEN_REPLAY');assert.equal(verification.summaryFieldsVerified,'all');
  assert.equal(verification.identity,identity.identity);assert.equal(verification.verifier_sha256,verifierHash);assert.equal(verification.promotionPass,false);
  assert.equal(execution.schema,'lifeline-supervised-verification-receipt-v1');assert.equal(execution.verifier_exit_code,0);
  assert.equal(execution.arena_identity,identity.identity);assert.equal(execution.verifier_sha256,verifierHash);
  assert.equal(execution.arena_summary_sha256,sha(await observe(resolve(runRoot,'summary.json'))));
  assert.equal(execution.verification_sha256,sha(await observe(resolve(runRoot,'verification.json'))));
  assert.deepEqual(execution.command.slice(1),[resolve(ROOT,VERIFIER),'--arena-root',runRoot,'--candidates',resolve(identity.candidateManifestPath)]);
  assert.equal(execution.identity,sha(JSON.stringify({arena:sha(await observe(resolve(runRoot,'identity.json'))),
    summary:sha(await observe(resolve(runRoot,'summary.json'))),verifier:verifierHash,
    candidates:sha(await observe(identity.candidateManifestPath)),adapter:sha(await observe(resolve(ROOT,ADAPTER)))})));
  const plans=expectedPlans(candidates,config),paths=plans.map(p=>`games/${p.id}.json`);
  assert.equal(plans.length,420);assert.equal(identity.plannedGames,420);assert.equal(verification.games,420);
  assert.deepEqual(cp.completed.map(r=>r.path),paths,'Missing, duplicated or reordered game index');
  const games=[];let actions=0,sampled=0;
  for(const ref of cp.completed){const bytes=await observe(inside(runRoot,ref.path));assert.equal(sha(bytes),ref.sha256,'Game bytes changed');
    const game=JSON.parse(bytes);games.push(game);sampled+=replayAndCheck(game,config);actions+=game.actions.length;}
  const result=reconstruct(games,candidates,config),terminalGames=games.filter(g=>g.terminal).length;
  assert.deepEqual(summary,{identity:identity.identity,status:'COMPLETE_APPLICATION_SCREEN',promotionPass:false,
    decision:'Retain shipped defaults. This small paired screen is not a release gate or a multiplicity-adjusted strength confirmation.',
    terminalGames,truncatedGames:games.length-terminalGames,models:result.summaryRows},'Summary differs from independent game aggregation');
  assert.equal(verification.actions,actions);assert.equal(verification.sampledPolicyDecisions,sampled);
  assert.equal(verification.terminalGames,terminalGames);assert.equal(verification.truncatedGames,games.length-terminalGames);
  assert.equal(cp.units,games.reduce((sum,g)=>sum+g.actions.length-g.prefixLength+1,0));assert.equal(progress.progress_units,cp.units);
  const sourceHashes={};
  for(const path of [SELF,resolve(ROOT,'web/web前端/GameEngine.js')])sourceHashes[relative(ROOT,path).replaceAll('\\','/')]=sha(await observe(path));
  // Detect accidental changes across this bounded read-only assessment.
  for(const [path,hash] of observed)assert.equal(sha(await readFile(path)),hash,`Input changed during assessment: ${path}`);
  return {schema:'lifeline-neural-confirmation-assessment-v1',status:'PASS_CONFIRMATION_ASSESSMENT',
    arenaIdentity:identity.identity,gate:config.confirmation_gate,models:result.statisticalRows,holm:result.holm,
    modelCount:candidates.length,games:games.length,terminalGames,truncatedGames:games.length-terminalGames,
    eligibleModelIds:result.statisticalRows.filter(r=>r.promotionPass).map(r=>r.id),sourceHashes,
    inputHashes:Object.fromEntries(observed),verificationScope:{legalHistoryActionsReplayed:actions,
      freshTerminalAreasChecked:terminalGames,policyDecisionsRecomputedHere:0,upstreamPolicyDecisionsRecomputed:sampled,
      upstreamVerifier:VERIFIER,upstreamVerifierExitCode:0},
    nullHypothesis:'For a predeclared model and every fixed size stratum, P(positive paired-opening score difference | nonzero difference, size) <= 1/2, with independent nonzero cluster signs. The binomial boundary tail is exact when every retained sign has probability 1/2, otherwise conservative. This is not a mean-score null or merely a mixed-average sign-probability null.',
    limitations:['Seven selected models form the fixed Holm family; selection used the prior screen, not these confirmation openings.',
      'Bootstrap intervals are descriptive, stratified by size, and not adjusted for seven-model multiplicity.',
      'Fixed-size strata need not be identically distributed. Sign-test validity requires independent cluster signs and the joint size-specific null; it does not follow from only a pooled average probability <= 1/2. Deterministic seeded openings rely on the prespecified sampling model for statistical interpretation.',
      'Incomplete or truncated models cannot promote and use p=1 in the fixed Holm family.',
      'This checks legal histories and area, but relies on the required upstream verifier for its first/middle policy decision probes.',
      'Eligibility is scoped to these paired openings, opponents, sizes and inference budgets. Runtime defaults are not changed here.']};
}

if(process.argv[1]&&resolve(process.argv[1])===SELF){
  const args=process.argv.slice(2),opt=(name)=>{const i=args.indexOf(name);assert.ok(i>=0&&args[i+1],`Missing ${name}`);return args[i+1];};
  try{
    const run=resolve(opt('--run-root')),execution=resolve(opt('--verification-execution'));
    const report=await assessConfirmation(run,execution),output=resolve(run,'confirmation-assessment.json');
    const bytes=JSON.stringify(report,null,2)+'\n';
    let existing=null;try{existing=await readFile(output,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(existing!==null)assert.equal(existing,bytes,'Existing assessment differs; preserve it and use a versioned protocol');
    else{const temporary=output+'.'+process.pid+'.tmp';await writeFile(temporary,bytes,{flag:'wx'});await rename(temporary,output);}
    console.log(JSON.stringify({status:report.status,games:report.games,eligibleModelIds:report.eligibleModelIds,output}));
  }catch(error){console.error(error.stack);process.exitCode=1;}
}
