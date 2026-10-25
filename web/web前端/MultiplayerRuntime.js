import { fastPolicyCandidates, isolatedSearchEngine, MultiplayerMinimaxAI } from "./MultiplayerSearch.js?v=20261025-room1";
import { createMultiplayerModel } from "./MultiplayerModel.js?v=20261025-room1";
import { MultiplayerRolloutAI } from "./MultiplayerRollout.js?v=20261025-room1";
import { loadThreePlayerRuntime } from "./ThreePlayerRuntime.js?v=20261025-room1";
import { threePlayerModelIdForBoard } from "./ThreePlayerSearchOptions.js?v=20261025-room1";
import { loadHexPlayerModel } from "./HexPlayerAI.js?v=20261025-room1";
import { createUltimateAdmissionGuard } from "./MultiplayerUltimateAdmission.js?v=20261025-room1";
import { GameEngine } from "./GameEngine.js?v=20261025-room1";
import { applyStandardDefenseGate } from "./MultiplayerStandardDefense.js?v=20261025-room1";

export const MULTIPLAYER_MODEL_IDS=Object.freeze(["multiplayer-easy-v1","multiplayer-medium-v1","multiplayer-hard-v1","multiplayer-ultimate-v1"]);
const promises=new Map(), baseUrl=new URL("./assets/research-ai/multiplayer-v1/",import.meta.url);
const ultimateAdmission=createUltimateAdmissionGuard();
const compare=(a,b)=>b.score-a.score||a.point[1]-b.point[1]||a.point[0]-b.point[0];
const safePassModels=new Set(["multiplayer-easy-v1","multiplayer-medium-v1"]);
function canonicalTerminalWinningPass(source,player){
  if(source.gameOver||player!==source.currentPlayer) return null;
  const remaining=source.activePlayers.filter(candidate=>!source.resignedPlayers.has(candidate));
  if(remaining.length<2||source.consecutiveSkips!==remaining.length-1||!source.getLegalMoves(player).length) return null;
  const isolated=isolatedSearchEngine(source), result=isolated.skipTurn();
  if(!result.success||!isolated.gameOver) return null;
  GameEngine.prototype._updateTerritories.call(isolated);
  return isolated.getWinner()===player
    ? {type:"pass",point:null,score:1,prior:1,visits:1,evaluation:"canonical-terminal-unique-win"}
    : null;
}
export class FastMultiplayerPolicy {
  constructor(spec){
    this.spec=spec;this.lastSearch=null;
    // Only this linear policy promises every legal placement, with exactly
    // the same score and tie order used by rollout root enumeration.
    this.fullRankingContract=Object.freeze({kind:"multiplayer-linear-full-ranking",version:1,spec});
  }
  getFullRanking(engine,player=engine.currentPlayer,{includeFeatures=false}={}){
    return this._rank(engine,player,includeFeatures);
  }
  _rank(engine,player,includeFeatures=false){
    const start=performance.now();
    const moves=fastPolicyCandidates(engine,player).map(m=>{
      const move={point:m.point,
        score:m.features.reduce((v,x,i)=>v+x*this.spec.weights[i],0)/(this.spec.temperature??1),visits:1};
      if(includeFeatures) Object.defineProperty(move,"features",{value:m.features,enumerable:false});
      return move;
    }).sort(compare);
    const max=moves[0]?.score??0, total=moves.reduce((v,m)=>v+Math.exp(m.score-max),0);
    moves.forEach(m=>{m.prior=Math.exp(m.score-max)/total;});
    this.lastSearch={elapsedMs:performance.now()-start,algorithm:"trained-linear-policy",legalCandidates:moves.length};
    return moves;
  }
  getTopMoves(engine,player=engine.currentPlayer,topN=5){
    return this._rank(engine,player).slice(0,topN);
  }
}
export function prepareStandardDefenseRanking(policy,source,player,width){
  const contract=policy.fullRankingContract;
  if(contract?.kind==="multiplayer-linear-full-ranking"&&contract.version===1
    &&typeof policy.getFullRanking==="function"){
    const completeRanking=policy.getFullRanking(source,player,{includeFeatures:true});
    return {original:completeRanking.slice(0,width),completeRanking};
  }
  return {original:policy.getTopMoves(source,player,width),completeRanking:null};
}
async function assetModel(id){
  if(!promises.has(id)) promises.set(id,(async()=>{
    const response=await fetch(new URL("manifest.json",baseUrl));
    if(!response.ok) throw new Error("多人训练模型尚未就绪，请选择中等或困难 AI。");
    const manifest=await response.json();
    if(manifest?.schema?.name!=="lifeline-multiplayer-runtime"||manifest.schema.version!==1) throw new Error("Invalid multiplayer model manifest");
    const spec=manifest.models.find(m=>m.id===id);
    if(!spec||!Number.isInteger(spec.training?.updates)||spec.training.updates<1) throw new Error("Missing trained multiplayer model identity");
    if(id==="multiplayer-easy-v1"){
      if(spec.weights?.length!==16||!spec.weights.every(Number.isFinite)||!Number.isFinite(spec.temperature)||spec.temperature<=0) throw new Error("Invalid basic AI weights");
      return {spec};
    }
    if(!/^[a-f\d]{64}$/.test(spec.asset_sha256??"")||!/^[-a-z\d]+\.f32$/.test(spec.asset??"")) throw new Error("Invalid multiplayer asset identity");
    const weights=await fetch(new URL(spec.asset,baseUrl));
    if(!weights.ok) throw new Error("无法加载终极 AI 权重。");
    const bytes=await weights.arrayBuffer();
    const digest=await crypto.subtle.digest("SHA-256",bytes);
    const hash=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
    if(hash!==spec.asset_sha256) throw new Error("终极 AI 权重校验失败。");
    return createMultiplayerModel(spec,bytes);
  })().catch(error=>{promises.delete(id);throw error;}));
  return promises.get(id);
}
export async function createMediumRuntime(engine){
  if(engine.playerCount===3){
    const runtime=await loadThreePlayerRuntime(threePlayerModelIdForBoard(engine.gridSize),engine);
    if(runtime.ai.base){
      // Same v4 weights, shortlist, opponents, rollout length and canonical leaf
      // scoring. Only equivalent candidate enumeration/feature work changes.
      runtime.ai.base=new FastMultiplayerPolicy(runtime.ai.spec);
      runtime.ai.responses=runtime.ai.spec.search.opponents.map(s=>new FastMultiplayerPolicy(s));
      const original=runtime.ai;
      return {ai:{lastSearch:null,getTopMoves(source,player,n){
        const result=original.getTopMoves(isolatedSearchEngine(source),player,n);
        this.lastSearch=original.lastSearch; return result;
      }},modelInfo:runtime.modelInfo,weights:runtime.ai.spec.weights,
        policySpec:runtime.ai.spec,responseSpecs:runtime.ai.spec.search.opponents};
    }
    return {ai:new FastMultiplayerPolicy(runtime.ai.model.spec),modelInfo:runtime.modelInfo,weights:runtime.ai.model.spec.weights,
      policySpec:runtime.ai.model.spec,responseSpecs:[runtime.ai.model.spec]};
  }
  const model=await loadHexPlayerModel();
  return {ai:new FastMultiplayerPolicy(model.spec),modelInfo:{id:model.spec.id},weights:model.spec.weights,
    policySpec:model.spec,responseSpecs:[model.spec]};
}
export async function loadMultiplayerRuntime(modelId,engine){
  if(!MULTIPLAYER_MODEL_IDS.includes(modelId)||![3,4,5,6].includes(engine.playerCount)
    ||!["territory-v2", "territory-v3"].includes(engine.rulesVersion)||engine.gridSize<5||engine.gridSize>15) throw new Error("Unsupported multiplayer AI configuration");
  const native=engine.boardShape===(engine.playerCount===3?"triangle":"hexagon");
  if(!native&&["multiplayer-medium-v1","multiplayer-ultimate-v1"].includes(modelId)) throw new Error("This AI requires the native multiplayer board shape");
  let ai, lineage=null;
  if(modelId==="multiplayer-medium-v1"){
    const medium=await createMediumRuntime(engine); ai=medium.ai; lineage=medium.modelInfo.id;
  }else if(modelId==="multiplayer-easy-v1"){
    const model=await assetModel(modelId); ai=new FastMultiplayerPolicy(model.spec); lineage=model.spec.training;
  }else if(modelId==="multiplayer-hard-v1"){
    if(native){
      const { loadNativeHardRuntime } = await import("./MultiplayerHardResources.js?v=20261025-room1");
      return loadNativeHardRuntime(engine);
    }else ai=new MultiplayerMinimaxAI({depth:Math.min(engine.playerCount+1,6),timeMs:650});
  }else{
    const model=await assetModel(modelId); lineage=model.spec.training;
    const admission=ultimateAdmission.checkProfile({strategy:"multiplayer",modelId},engine,model.spec);
    if(!admission.allowed){const error=new Error(admission.message);error.code=admission.code;throw error;}
    const medium=await createMediumRuntime(engine);
    ai={lastSearch:null,getTopMoves(source,player=source.currentPlayer,n=5){
      const start=performance.now(), isolated=isolatedSearchEngine(source);
      const output=model.evaluate(isolated), inferenceMs=performance.now()-start;
      const rootPrior=new Map(output.priors.map(p=>[p.point.join(","),p.prior]));
      // The trained placement head supplies a legal decision even when the
      // complete comparison cannot finish. Untrained PASS/value heads do not
      // choose the fallback; PASS is used only when there is no legal placement.
      let best=null;
      for(const candidate of output.priors) if(!best||candidate.prior>best.prior
        ||candidate.prior===best.prior&&(candidate.point[1]<best.point[1]
          ||candidate.point[1]===best.point[1]&&candidate.point[0]<best.point[0])) best=candidate;
      const fallbackMove=best?{type:"move",point:[...best.point],score:best.prior,prior:best.prior,visits:1}
        :{type:"pass",point:null,score:0,visits:1};
      const search=new MultiplayerRolloutAI({basePolicy:medium.policySpec,responsePolicies:[medium.policySpec],
        fallbackMove,fallbackKind:best?"gnn-placement-argmax":"no-legal-placement-pass",
        publishCompletedComparisons:true,timeMs:Math.max(10,650-inferenceMs),rootPriors:rootPrior,rolloutPlies:[12,24,36]});
      const moves=search.getTopMoves(isolated,player,n);
      this.lastSearch={...search.lastSearch,inferenceMs,elapsedMs:performance.now()-start,
        gnnFallbackPoint:fallbackMove.point,algorithm:"transferred-gnn-anytime-rollout-canonical-area"};
      return moves;
    }};
  }
  const policy=ai;
  ai={lastSearch:null,getTopMoves(source,player=source.currentPlayer,n=5,options={}){
    if(source.gameOver) return [];
    if(n>0&&safePassModels.has(modelId)&&options.terminalWinningPassPrechecked!==true){
      const pass=canonicalTerminalWinningPass(source,player);
      if(pass){this.lastSearch={algorithm:"canonical-terminal-unique-win",legalCandidates:1};return [pass];}
    }
    if(!safePassModels.has(modelId)){
      const moves=policy.getTopMoves(source,player,n); this.lastSearch=policy.lastSearch;
      if(n>0&&!moves.length&&!source.getLegalMoves(player).length) return [{type:"pass",point:null,score:0,visits:1}];
      return moves;
    }
    const requested=Math.max(0,Math.floor(n));
    let prepared;
    try { prepared=prepareStandardDefenseRanking(policy,source,player,Math.max(requested,4)); }
    catch (_) {
      const original=policy.getTopMoves(source,player,Math.max(requested,4));
      this.lastSearch=policy.lastSearch; return original.slice(0,requested);
    }
    const {original,completeRanking}=prepared;
    const originalSearch=policy.lastSearch;
    const gateStarted=performance.now();
    let gate={moves:original,receipt:{status:"preserved-not-run"}};
    if(requested>0&&original.length>1) {
      gate=applyStandardDefenseGate(source,original,{completeRanking,startedAt:gateStarted});
    }
    this.lastSearch={...(originalSearch??{}),standardDefenseGate:gate.receipt};
    if(requested>0&&!gate.moves.length&&!source.getLegalMoves(player).length) return [{type:"pass",point:null,score:0,visits:1}];
    return gate.moves.slice(0,requested);
  }};
  return {ai,modelInfo:{id:modelId,lineage,evidenceTier:"application-candidate",compatibility:`${engine.rulesVersion} 3–6 players; size 5–15`}};
}
