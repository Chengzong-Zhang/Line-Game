// Selective, v1-anchored local candidate. Runtime promotion is a separate gate.
import { saveState, restoreState, fastTerritoryBFS } from "./AIEngine.js?v=20261026-start-protection-v1";
import { GameEngine } from "./GameEngine.js?v=20261026-start-protection-v1";
import { HEX_PLAYER_FEATURES, hexPlayerCandidates } from "./HexPlayerAI.js?v=20261026-start-protection-v1";

const pointOrder = (a,b) => a.point[1]-b.point[1] || a.point[0]-b.point[0];
const samePoint = (a,b) => a[0]===b[0] && a[1]===b[1];
const cloneTerritories = (value) => Object.fromEntries(Object.entries(value).map(([p,t]) =>
  [p,{...t,polygon:t.polygon?.map((point)=>[...point])??null}]));
function restoreIsolated(engine,snapshot) {
  restoreState(engine,snapshot);
  // restoreState aliases its snapshot cache. Every branch must own its map.
  engine.cachedTerritories=cloneTerritories(snapshot.cachedTerritories);
}
function evaluateLeaf(engine,player,spec) {
  engine.cachedTerritories=cloneTerritories(engine.cachedTerritories);
  // Workers may suppress the instance updater. Always use the rules' real area.
  GameEngine.prototype._updateTerritories.call(engine);
  const active=engine.activePlayers.filter(p=>!engine.resignedPlayers.has(p));
  const areas=Object.fromEntries(active.map(p=>[p,engine.cachedTerritories[p].area]));
  const maximum=Math.max(...Object.values(areas));
  const winners=active.filter(p=>areas[p]===maximum);
  if(engine.gameOver) return {terminal:true,value:winners.includes(player)?1/winners.length:0,areas};
  // Bounded positional preference, not a calibrated win probability.
  const strength=active.map(p=>areas[p]
    +spec.coverageWeight*(engine._getPlayerNodes(p).length+engine._getPlayerLines(p).length)
    +spec.reachWeight*fastTerritoryBFS(engine,p));
  const top=Math.max(...strength), scale=engine.validPositions.length*spec.valueTemperature;
  const exp=strength.map(v=>Math.exp((v-top)/scale));
  return {terminal:false,value:exp[active.indexOf(player)]/exp.reduce((a,b)=>a+b,0),areas};
}

// A heuristic preference is never compared as though it were a true terminal
// reward. Confirmed (possibly shared) wins outrank incomplete leaves; confirmed
// losses rank below them. This is conditional on the simulated v1 responses.
export function chooseHexSearchLeafV4(evaluated,minimumImprovement) {
  const tier=leaf=>leaf.terminal?(leaf.value>0?2:0):1;
  const baseline=evaluated[0];
  const best=[...evaluated].sort((a,b)=>tier(b)-tier(a)||b.value-a.value||b.baseScore-a.baseScore||pointOrder(a,b))[0];
  if(tier(best)>tier(baseline)) return best;
  if(best.value>baseline.value && (best.terminal || best.value-baseline.value>=minimumImprovement)) return best;
  return baseline;
}

export class HexSearchAI {
  constructor(payload) {
    const s=payload?.search;
    if(payload?.schema?.name!=="lifeline-hex-player-search" || payload.schema.version!==4
      || payload.id!=="hex-player-search-v4" || payload.rules_version!=="territory-v2"
      || JSON.stringify(payload.features)!==JSON.stringify(HEX_PLAYER_FEATURES)
      || JSON.stringify(payload.browser_inference?.player_counts)!=="[4,5,6]"
      || JSON.stringify(payload.browser_inference?.board_size_range)!=="[5,15]"
      || !Array.isArray(payload.browser_inference?.search_board_sizes) || !payload.browser_inference.search_board_sizes.length
      || new Set(payload.browser_inference.search_board_sizes).size!==payload.browser_inference.search_board_sizes.length
      || payload.browser_inference.search_board_sizes.some(n=>!Number.isInteger(n)||n<5||n>15)
      || payload.parent?.id!=="hex-player-policy-v1" || !/^[a-f0-9]{64}$/.test(payload.parent.sha256??"")
      || !Array.isArray(payload.weights) || payload.weights.length!==16 || !payload.weights.every(v=>Number.isFinite(v)&&Math.abs(v)<10000)
      || !Number.isFinite(payload.temperature) || payload.temperature<=0
      || !s || !Number.isInteger(s.rootWidth) || s.rootWidth<1 || s.rootWidth>3
      || !Number.isInteger(s.maxBoardSize) || s.maxBoardSize<5 || s.maxBoardSize>15
      || payload.browser_inference.search_board_sizes.some(n=>n>s.maxBoardSize)
      || !Number.isInteger(s.maxResponsePlies) || s.maxResponsePlies<0 || s.maxResponsePlies>5
      || !Number.isInteger(s.lowLegalThreshold) || s.lowLegalThreshold<0 || s.lowLegalThreshold>631
      || !Number.isInteger(s.connectionGainThreshold) || s.connectionGainThreshold<1
      || ![s.priorWindow,s.minimumImprovement,s.coverageWeight,s.reachWeight,s.valueTemperature].every(Number.isFinite)
      || s.priorWindow<0 || s.minimumImprovement<0 || s.minimumImprovement>1
      || s.coverageWeight<0 || s.reachWeight<0 || s.valueTemperature<=0) throw new Error("Invalid hex v4 search candidate");
    this.spec=structuredClone(payload); this.lastSearch=null;
  }

  rank(engine,player) {
    const candidates=hexPlayerCandidates(engine,player);
    const values=candidates.map(c=>({...c,baseScore:c.features.reduce((v,x,i)=>v+x*this.spec.weights[i],0)/this.spec.temperature}));
    values.sort((a,b)=>b.baseScore-a.baseScore||pointOrder(a,b));
    return values;
  }

  getTopMoves(engine,player=engine.currentPlayer,topN=5) {
    const started=Date.now(), stats={simulations:0,simulatedActions:0,terminalLeaves:0,policyCalls:0,policyMs:0,valueMs:0,transitionMs:0,elapsedMs:0,evaluated:[],reason:"unstarted"};
    this.lastSearch=stats;
    if(![4,5,6].includes(engine.playerCount)||!["territory-v2", "territory-v3"].includes(engine.rulesVersion)
      ||engine.currentPlayer!==player||engine.gridSize<5||engine.gridSize>15) throw new Error("Hex v4 requires the current actor in 4–6 player territory-v2, size 5–15");
    if(engine.gameOver||engine.resignedPlayers.has(player)){stats.reason="terminal-or-inactive";return [];}
    const snapshot=saveState(engine), flag=engine._isReplayingBatch;
    engine._isReplayingBatch=true;
    try {
      const rankHere=actor=>{const t=Date.now();try{return this.rank(engine,actor);}finally{stats.policyCalls++;stats.policyMs+=Date.now()-t;}};
      const all=rankHere(player);
      if(!all.length){stats.reason="no-legal-move";return [];}
      const s=this.spec.search;
      const shortlist=all.filter(m=>all[0].baseScore-m.baseScore<=s.priorWindow).slice(0,s.rootWidth);
      const tactical=all.length<=s.lowLegalThreshold||shortlist.some(m=>m.features[6]>0||m.features[10]===1
        ||m.features[9]*engine.validPositions.length>=s.connectionGainThreshold-1e-9);
      let chosen=all[0];
      if(!this.spec.browser_inference.search_board_sizes.includes(engine.gridSize)) stats.reason="unsupported-search-size-v1";
      else if(shortlist.length<2) stats.reason="single-or-clear-prior";
      else if(!tactical) stats.reason="quiet-v1";
      else {
        stats.reason="searched-v1-kept";
        for(const move of shortlist){
          restoreIsolated(engine,snapshot);
          let transitionStart=Date.now();
          if(!engine.playMove(move.point).success) throw new Error("Hex v4 root move rejected");
          stats.transitionMs+=Date.now()-transitionStart;
          stats.simulatedActions++;
          // Actual currentPlayer follows auto skips and resignations. A repeated
          // opponent means the root was skipped; never guess the next seat.
          const seen=new Set();
          for(let ply=0;ply<s.maxResponsePlies&&!engine.gameOver&&engine.currentPlayer!==player;ply++){
            if(seen.has(engine.currentPlayer)) break;
            seen.add(engine.currentPlayer);
            const reply=rankHere(engine.currentPlayer)[0]?.point??null;
            if(reply===null && engine.getLegalMoves().length) throw new Error("Hex v4 cannot force a legal actor to pass");
            transitionStart=Date.now();
            const result=reply===null?engine.skipTurn():engine.playMove(reply);
            stats.transitionMs+=Date.now()-transitionStart;
            if(!result.success) throw new Error("Hex v4 opponent reply rejected");
            stats.simulatedActions++;
          }
          const valueStart=Date.now(),leaf=evaluateLeaf(engine,player,s); stats.valueMs+=Date.now()-valueStart;
          stats.simulations++; stats.terminalLeaves+=Number(leaf.terminal);
          stats.evaluated.push({point:[...move.point],baseScore:move.baseScore,...leaf});
        }
        const best=chooseHexSearchLeafV4(stats.evaluated,s.minimumImprovement);
        if(!samePoint(best.point,all[0].point)){
          chosen=all.find(m=>samePoint(m.point,best.point)); stats.reason=best.terminal?"terminal-override":"searched-override";
        }
      }
      const exp=all.map(m=>Math.exp(m.baseScore-all[0].baseScore)),total=exp.reduce((a,b)=>a+b,0);
      const output=all.map((m,i)=>({point:[...m.point],score:m.baseScore,baseScore:m.baseScore,prior:exp[i]/total,visits:1,
        searchValue:stats.evaluated.find(e=>samePoint(e.point,m.point))?.value??null}));
      // First result is the chosen action. score/prior retain their v1 meaning;
      // callers must not re-sort them and silently discard the search decision.
      const selected=output.findIndex(m=>samePoint(m.point,chosen.point));
      if(selected>0) output.unshift(...output.splice(selected,1));
      return output.slice(0,Math.max(0,Math.floor(topN)));
    } finally {
      restoreIsolated(engine,snapshot); engine._isReplayingBatch=flag;
      stats.elapsedMs=Date.now()-started;
    }
  }
}
