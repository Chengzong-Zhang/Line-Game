// Web runtime source SHA-256: f75b52b07bfded228413de9ff8f02259e6c0b393f7b29ee9f58f9cb9478c1914
// Native adaptation: injected asset loaders, local clock, and unavailable ultimate omitted.
import { multiplayerClock as performance } from "./MultiplayerClock.js";
import { fastPolicyCandidates, isolatedSearchEngine, MultiplayerMinimaxAI } from "./MultiplayerSearch.js";
import { MultiplayerRolloutAI } from "./MultiplayerRollout.js";
import { threePlayerModelIdForBoard } from "./ThreePlayerSearchOptions.js";

export const MULTIPLAYER_MODEL_IDS=Object.freeze(["multiplayer-easy-v1","multiplayer-medium-v1","multiplayer-hard-v1"]);
const compare=(a,b)=>b.score-a.score||a.point[1]-b.point[1]||a.point[0]-b.point[0];
export class FastMultiplayerPolicy {
  constructor(spec){
    this.spec=spec;this.lastSearch=null;
    // Only this linear policy promises every legal placement, with exactly
    // the same score and tie order used by rollout root enumeration.
    this.fullRankingContract=Object.freeze({kind:"multiplayer-linear-full-ranking",version:1,spec});
  }
  getFullRanking(engine,player=engine.currentPlayer){return this.getTopMoves(engine,player,Infinity);}
  getTopMoves(engine,player=engine.currentPlayer,topN=5){
    const start=performance.now();
    const moves=fastPolicyCandidates(engine,player).map(m=>({point:m.point,
      score:m.features.reduce((v,x,i)=>v+x*this.spec.weights[i],0)/(this.spec.temperature??1),visits:1})).sort(compare);
    const max=moves[0]?.score??0, total=moves.reduce((v,m)=>v+Math.exp(m.score-max),0);
    moves.forEach(m=>{m.prior=Math.exp(m.score-max)/total;});
    this.lastSearch={elapsedMs:performance.now()-start,algorithm:"trained-linear-policy",legalCandidates:moves.length};
    return moves.slice(0,topN);
  }
}
export async function createMediumRuntime(engine,resources){
  if(engine.playerCount===3){
    const runtime=await resources.loadThreePlayerRuntime(threePlayerModelIdForBoard(engine.gridSize),engine);
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
  const model=await resources.loadHexPlayerModel();
  return {ai:new FastMultiplayerPolicy(model.spec),modelInfo:{id:model.spec.id},weights:model.spec.weights,
    policySpec:model.spec,responseSpecs:[model.spec]};
}
export async function loadMultiplayerRuntime(modelId,engine,resources){
  if(engine?.rootMode&&engine.rootMode!=="classic") throw new Error("Multiplayer trained AI does not support multi-root rules");
  if(!MULTIPLAYER_MODEL_IDS.includes(modelId)||![3,4,5,6].includes(engine.playerCount)
    ||!["territory-v2", "territory-v3"].includes(engine.rulesVersion)||engine.gridSize<5||engine.gridSize>15) throw new Error("Unsupported multiplayer AI configuration");
  const native=engine.boardShape===(engine.playerCount===3?"triangle":"hexagon");
  if(!native&&["multiplayer-medium-v1","multiplayer-ultimate-v1"].includes(modelId)) throw new Error("This AI requires the native multiplayer board shape");
  let ai, lineage=null;
  if(modelId==="multiplayer-medium-v1"){
    const medium=await createMediumRuntime(engine,resources); ai=medium.ai; lineage=medium.modelInfo.id;
  }else if(modelId==="multiplayer-easy-v1"){
    const model=await resources.loadAssetModel(modelId); ai=new FastMultiplayerPolicy(model.spec); lineage=model.spec.training;
  }else if(modelId==="multiplayer-hard-v1"){
    if(native){
      const medium=await createMediumRuntime(engine,resources);lineage=medium.modelInfo.id;
      ai=new MultiplayerRolloutAI({basePolicy:medium.policySpec,responsePolicies:[medium.policySpec],
        fallbackPolicy:medium.ai,timeMs:650,rolloutPlies:[12,24]});
    }else ai=new MultiplayerMinimaxAI({depth:Math.min(engine.playerCount+1,6),timeMs:650});
  }
  const policy=ai;
  ai={lastSearch:null,getTopMoves(source,player=source.currentPlayer,n=5){
    if(source.gameOver) return [];
    const moves=policy.getTopMoves(source,player,n); this.lastSearch=policy.lastSearch;
    if(n>0&&!moves.length&&!source.getLegalMoves(player).length) return [{type:"pass",point:null,score:0,visits:1}];
    return moves;
  }};
  return {ai,modelInfo:{id:modelId,lineage,evidenceTier:"application-candidate",compatibility:"territory-v2 3–6 players; size 5–15"}};
}
