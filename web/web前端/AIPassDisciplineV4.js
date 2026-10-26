// Product-only terminal certificate. V1/V2/V3 and training stay immutable.
import { applyPassDiscipline as applyV3 } from "./AIPassDisciplineV3.js?v=20261026-start-protection-v1";
import { nativeDiscreteAreas } from "./AIPassDiscipline.js?v=20261026-start-protection-v1";
import { passDisciplineStateHash } from "./AIPassDisciplineV2.js?v=20261026-start-protection-v1";
import { saveState, restoreState } from "./AIEngine.js?v=20261026-start-protection-v1";
import { isolatedSearchEngine } from "./MultiplayerSearch.js?v=20261026-start-protection-v1";
import { multiplayerClock } from "./MultiplayerClock.js?v=20261026-start-protection-v1";
export const PASS_DISCIPLINE_CONTRACT = Object.freeze({
  schema: "lifeline-ai-pass-discipline-v4",
  scope: "Analytic one-actual-opponent-round envelope for native v3 hex 4-6 seats, with singleton birth enemies, first-cut shielding, rooted retained coverage and a permanently legal reserved return; no enumerated reply-round claim",
  terminalMargin: "original terminal PASS margin >0 requires strictly positive certified lower bound; margin =0 requires nonnegative certified lower bound",
  budget: "Same shared total proof budget; at most 12 specialized roots, actual remaining time/nodes to unchanged V3; no AI model/search budget change",
});
const key = point => point === null ? "PASS" : point.join(",");
const aligned = (a,b) => a[0] === b[0] || a[1] === b[1] || a[0] + a[1] === b[0] + b[1];
const own = (engine, player) => ({ nodes: new Set(engine._getPlayerNodes(player).map(key)),
  points: [...engine._getPlayerNodes(player), ...engine._getPlayerLines(player)],
  coverage: new Set([...engine._getPlayerNodes(player), ...engine._getPlayerLines(player)].map(key)) });
const contains = (all, required) => [...required].every(point => all.has(point));
const TIMEOUT = Symbol("v4 shared terminal proof budget");

export function terminalEnvelopeForRoot(engine, player, before, beforeArea, passMargin, budget = () => {}, analyticalProbes = { actorLineTargets: 0, historyRecords: 0, segmentTargets: 0, nativeAreaCalls: 0 }) {
  budget();
  const after = own(engine, player), connected = engine._getOpponentConnectedPieces(player), states = engine._getPlayerStates(player);
  if (!contains(after.nodes, before.nodes) || !contains(after.coverage, before.coverage)
    || !contains(connected, after.coverage) || after.coverage.size <= beforeArea) return null;
  const enemies = engine.activePlayers.filter(actor => actor !== player && !engine.resignedPlayers.has(actor));
  for (const enemy of enemies) {
    budget(); const nodes = engine._getPlayerNodes(enemy);
    if (nodes.length !== 1 || key(nodes[0]) !== key(engine.initialPositions[enemy]) || engine._getPlayerLines(enemy).length) return null;
    // Before the first actor cut, every enemy's first placement must connect
    // to its singleton birth. A protected target is forbidden; an actor NODE
    // strictly inside every other attack ray blocks that first cut forever
    // through this round. No temporary first-cut assumption is circular.
    for (const line of engine._getPlayerLines(player)) {
      budget(); analyticalProbes.actorLineTargets++;
      if (!aligned(nodes[0], line) || engine._isInProtectionZone(line, enemy)) continue;
      const cells = engine.getLinePoints(nodes[0], line);
      if (!cells.slice(1,-1).some(point => engine._getState(point) === states.node)) return null;
    }
  }
  // A protected own LINE adjacent to birth stays unoccupiable by enemy NODEs.
  // Fixed actor nodes preserve its local three-point/connect predicates.
  // No old/current/future enemy-only hash can contain its new actor NODE.
  let reserved = null;
  for (const point of engine.getAdjacentPositions(engine.initialPositions[player])) {
    budget();
    if (engine._getState(point) !== states.line || engine._isInProtectionZone(point, player)
      || !engine._checkThreePointLimitation(point, player)
      || !engine._evaluateMove(point, player, engine._getPlayerNodes(player), engine._getStateHashOrder()).legal) continue;
    let absent = true;
    for (const hash of engine.historyHashes) {
      budget(); analyticalProbes.historyRecords++; let parsed;
      try { parsed = JSON.parse(hash); } catch (_) { absent = false; break; }
      if (!Array.isArray(parsed) || parsed.length !== 4 || !engine.activePlayers.includes(parsed[0])
        || !Array.isArray(parsed[1]) || parsed[1].some(p => !engine.activePlayers.includes(p))
        || !Array.isArray(parsed[2]) || parsed[2].some(row => !Array.isArray(row) || row.length !== 3
          || !row.every(Number.isInteger) || !engine.isValidPosition(row.slice(0,2)) || row[2] < 1 || row[2] > 2 * engine.playerCount)
        || !Array.isArray(parsed[3]) || parsed[3].length !== engine.playerCount || parsed[3].some(edges => !Array.isArray(edges) || edges.some(edge => typeof edge !== "string"))) {
        absent = false; break;
      }
      if (parsed[2].some(([x,y,state]) => x === point[0] && y === point[1] && state === states.node)) { absent = false; break; }
    }
    if (absent) { reserved = [...point]; break; }
  }
  if (!reserved) return null;
  const envelopes = [];
  for (const enemy of enemies) {
    const birth = engine.initialPositions[enemy]; let upper = 1, examinedSegments = 0, maximumPoint = null;
    for (const point of engine.validPositions) {
      budget(); analyticalProbes.segmentTargets++;
      if (key(point) === key(birth) || !aligned(birth,point) || engine._isInProtectionZone(point,enemy)) continue;
      const cells = engine.getLinePoints(birth,point);
      if (cells.some(cell => !engine.isValidPosition(cell) || after.coverage.has(key(cell)))) continue;
      // Actual enemy walls are a subset of ONE birth->q segment. Other enemy
      // interference only removes walls or reconstructs that same segment.
      // In this single-segment family, the full segment with other enemies
      // removed gives a conservative native-area upper bound. Retain P0 as
      // enemy obstacles; no union of incompatible enemy segments is used.
      const area = engine._computeOwnedWallArea(cells, after.points);
      analyticalProbes.nativeAreaCalls++;
      examinedSegments++;
      if (area > upper) { upper = area; maximumPoint = [...point]; }
    }
    envelopes.push({ player: enemy, nativeAreaUpperBound: upper, maximumPoint, examinedSegments });
  }
  const marginLowerBound = after.coverage.size - Math.max(0, ...envelopes.map(row => row.nativeAreaUpperBound));
  if (passMargin > 0 ? marginLowerBound <= 0 : passMargin === 0 ? marginLowerBound < 0 : true) return null;
  budget();
  return { ownAreaLowerBound: after.coverage.size, marginLowerBound, reservedReturn: reserved,
    everyPostRootCoverageCellBirthConnected: true, firstCutShieldedByActorNodes: true,
    reservedCanonicalLegalAndNeverHistoricalActorNode: true, enemies: envelopes };
}

export function applyPassDiscipline(source, rankedMoves, { player = source.currentPlayer, topN = 5,
  timeMs = 200, maxNodes = 10000, now = () => multiplayerClock.now(), ...options } = {}) {
  const original = Array.isArray(rankedMoves) ? rankedMoves : [], requested = Math.max(0,Math.floor(topN));
  const legacy = extra => applyV3(source,original,{ ...options,player,topN,timeMs,maxNodes,now,...extra });
  if (!requested || source.gameOver || source.rulesVersion !== "territory-v3" || source.boardShape !== "hexagon"
    || source.playerCount < 4 || source.playerCount > 6 || original[0]?.type !== "pass" || original[0]?.point !== null
    || player !== source.currentPlayer || source.resignedPlayers.has(player)
    || !Number.isFinite(timeMs) || timeMs < 0 || !Number.isInteger(maxNodes) || maxNodes < 0) return legacy();
  const started=now(); if (!Number.isFinite(started)) return legacy(); let nodes=0,rootsExamined=0;
  const analyticalProbes={actorLineTargets:0,historyRecords:0,segmentTargets:0,nativeAreaCalls:0};
  const elapsed=()=>{ const time=now();if(!Number.isFinite(time))throw new Error("Invalid PASS discipline clock");return time-started; };
  const budget=()=>{if(elapsed()>=timeMs||nodes>=maxNodes)throw TIMEOUT;};
  const fallback=()=>legacy({timeMs:Math.max(0,timeMs-elapsed()),maxNodes:Math.max(0,maxNodes-nodes)});
  try {
    budget();
    const enemies=source.activePlayers.filter(actor=>actor!==player&&!source.resignedPlayers.has(actor));
    if(enemies.some(actor=>source._getPlayerNodes(actor).length!==1
      ||key(source._getPlayerNodes(actor)[0])!==key(source.initialPositions[actor])||source._getPlayerLines(actor).length))return fallback();
    const engine=isolatedSearchEngine(source),initial=saveState(engine);budget();nodes++;
    if(!engine.skipTurn().success)throw new Error("Canonical PASS failed");budget();
    if(!engine.gameOver)return fallback();
    const passAreas=nativeDiscreteAreas(engine),passMargin=passAreas[player]-Math.max(0,...enemies.map(actor=>passAreas[actor]));
    if(passMargin<0)return fallback();
    restoreState(engine,initial);const before=own(engine,player),beforeArea=nativeDiscreteAreas(engine,[player])[player];
    const ownNodes=engine._getPlayerNodes(player);
    // Ordering only: no root is accepted without canonical play and the full
    // analytic certificate. Fallback still has the unchanged full-round guard.
    const roots=engine.getLegalMoves(player).map(move=>{
      budget();const points=new Set(before.coverage);
      for(const node of ownNodes)if(engine.canConnectWithBlocking(move.point,node,player))
        for(const cell of engine.getLinePoints(move.point,node))points.add(key(cell));
      return {point:[...move.point],coverage:points.size};
    }).sort((a,b)=>b.coverage-a.coverage||a.point[1]-b.point[1]||a.point[0]-b.point[0]).slice(0,12);
    for(const {point} of roots){
      budget();restoreState(engine,initial);nodes++;rootsExamined++;
      if(!engine.playMove(point).success)throw new Error("Terminal root ceased to be legal");
      const envelope=terminalEnvelopeForRoot(engine,player,before,beforeArea,passMargin,budget,analyticalProbes);
      if(!envelope)continue;
      const sourceStateHash=passDisciplineStateHash(source),postRootStateHash=passDisciplineStateHash(engine);budget();
      const receipt={schema:PASS_DISCIPLINE_CONTRACT.schema,status:"safe-profitable-expansion",complete:true,
        actor:player,rulesVersion:source.rulesVersion,positionRevision:source.positionRevision,sourceStateHash,
        passWouldEnd:true,passMargin,nodes,canonicalActions:nodes,nodeUnit:"canonical PASS/root actions",analyticalProbes,rootsExamined,elapsedMs:elapsed(),safetyScope:PASS_DISCIPLINE_CONTRACT.scope,
        witness:{point:[...point],beforeArea,minimumReplyAreaLowerBound:envelope.ownAreaLowerBound,
          minimumReplyMargin:envelope.marginLowerBound,profitKind:"strict-native-area-gain",
          proofType:"singleton-first-cut-and-native-segment-envelope-with-reserved-return",
          completeOpponentRound:false,analyticCompleteRound:true,sourceStateHash,postRootStateHash,...envelope,
          scope:PASS_DISCIPLINE_CONTRACT.scope}};
      const existing=original.find(move=>Array.isArray(move.point)&&key(move.point)===key(point));
      const selected=existing?{...existing}:{type:"move",point:[...point],score:envelope.ownAreaLowerBound-beforeArea,visits:1};
      selected.passDiscipline={schema:receipt.schema,status:receipt.status,profitKind:receipt.witness.profitKind,proofType:receipt.witness.proofType};
      return {moves:[selected,...original.filter(move=>key(move.point)!==key(point))].slice(0,requested),receipt};
    }
    return fallback();
  }catch(error){if(error!==TIMEOUT)throw error;return fallback();}
}
export function withPassDiscipline(policy){
  if(policy?.passDisciplineContract===PASS_DISCIPLINE_CONTRACT.schema)return policy;
  return {passDisciplineContract:PASS_DISCIPLINE_CONTRACT.schema,lastSearch:null,
    getTopMoves(source,player=source.currentPlayer,topN=5,options={}){
      const ranked=policy.getTopMoves(source,player,topN>0?Math.max(5,topN):topN,{...options,passDisciplinePrechecked:true});
      const result=options.passDisciplinePrechecked===true?{moves:ranked,receipt:null}:applyPassDiscipline(source,ranked,{player,topN});
      this.lastSearch={...(policy.lastSearch??{}),...(result.receipt?{passDiscipline:result.receipt}:{})};return result.moves;
    }};
}
