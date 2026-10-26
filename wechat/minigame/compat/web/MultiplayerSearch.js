import { multiplayerClock as performance } from "./MultiplayerClock.js";
import { installNativeEdgeGeometry } from "./MultiplayerNativeGeometry.js";
// Full legal-action paranoid minimax. Only alpha/beta bounds prune branches;
// elapsed time ends an iteration, never masquerades as an equivalent cutoff.
import { GameEngine } from "./GameEngine.js";
import { saveState, restoreState } from "./AIEngine.js";
import { evaluateReplyResilience } from "./MultiplayerHardValue.js";

const order = (a, b) => a.point===null ? (b.point===null?0:1) : b.point===null ? -1 : a.point[1] - b.point[1] || a.point[0] - b.point[0];
const key = p => p===null ? "PASS" : p.join(",");
const TIMEOUT = Symbol("search deadline");
const geometry = new Map();
function boardGeometry(engine) {
  const id = `${engine.boardShape}/${engine.gridSize}`;
  if (!geometry.has(id)) geometry.set(id, {
    keys: engine.validPositions.map(key),
    rays: engine.validPositions.map(p => engine._getCrawlRays(p).map(ray => ray.map(c => engine._keyToIdx.get(c.key)))),
  });
  return geometry.get(id);
}

// A new node must see an existing own node along one of the six rays.
// Keep the first enemy line (an attack), but never points behind an enemy.
// These are necessary rule conditions, not a heuristic candidate cap.
export function potentialMoves(engine, player = engine.currentPlayer) {
  if (engine.gameOver || engine.resignedPlayers.has(player)) return [];
  const own = engine._getPlayerStates(player), indices = new Set(), geo = boardGeometry(engine);
  const states = geo.keys.map(k => engine.grid.get(k));
  const enemy = new Set(engine._getOpponents(player).flatMap(p => Object.values(engine._getPlayerStates(p))));
  const nodes = new Set(engine.activePlayers.map(p => engine._getPlayerStates(p).node));
  for (let i = 0; i < states.length; i++) {
    if (states[i] !== own.node) continue;
    for (const ray of geo.rays[i]) for (const index of ray) {
      const state = states[index];
      if (!nodes.has(state)) indices.add(index);
      if (enemy.has(state)) break;
    }
  }
  return [...indices].sort((a, b) => a - b).filter(i => {
    if (engine._isInProtectionZone(engine.validPositions[i], player)) return false;
    if (enemy.has(states[i])) return true;
    const adjacent = engine._adjIdxList[i].filter(j => states[j] === own.node);
    return adjacent.length < 2 && adjacent.every(j => !engine._adjIdxList[j].some(k => states[k] === own.node));
  }).map(i => engine.validPositions[i]);
}

export function isolatedSearchEngine(source) {
  const engine = new GameEngine({ gridSize: source.gridSize, playerCount: source.playerCount,
    boardShape: source.boardShape, initialPositions: source.initialPositions,
    startPlayer: source.startPlayer, rulesVersion: source.rulesVersion,
    protectionRule: source.protectionRule, deferTerritoryUpdates: true });
  restoreState(engine, saveState(source));
  engine._isReplayingBatch = true;
  engine.getLegalMoves = function(player = this.currentPlayer) {
    const nodes = this._getPlayerNodes(player), hashOrder = this._getStateHashOrder();
    return potentialMoves(this, player).flatMap(point => {
      const v = this._evaluateMove(point, player, nodes, hashOrder);
      return v.legal ? [{ point: [...point], state: v.state, isAttack: v.isAttack }] : [];
    });
  };
  const lastLegal = new Map();
  engine._hasValidMoves = function(player) {
    if(this.gameOver || this.resignedPlayers.has(player)) return false;
    const nodes = this._getPlayerNodes(player), hashOrder = this._getStateHashOrder();
    const previous=lastLegal.get(player);
    // A cached witness is always revalidated against the present board AND
    // history. It changes probe order only; it cannot authorize a stale move.
    if(previous && this._evaluateMove(previous,player,nodes,hashOrder).legal) return true;
    for(const point of potentialMoves(this,player)) if(this._evaluateMove(point,player,nodes,hashOrder).legal){
      lastLegal.set(player,point); return true;
    }
    return false;
  };
  installNativeEdgeGeometry(engine);
  return engine;
}

// All empty components are shared across players. Each player's multi-source
// reach is its occupied cells plus the components touching those cells.
export function multiplayerMetrics(engine) {
  const n = engine.validPositions.length, owner = new Int8Array(n).fill(-1);
  const states = engine.validPositions.map(p => engine._getState(p));
  const colors = engine.activePlayers, result = {};
  const stateOwner = new Map();
  colors.forEach((p, i) => {
    const s = engine._getPlayerStates(p);
    stateOwner.set(s.node, i); stateOwner.set(s.line, i);
    result[p] = { nodes: 0, coverage: 0, reach: 0, frontier: 0 };
  });
  states.forEach((s, i) => {
    if (!stateOwner.has(s)) return;
    const j = stateOwner.get(s), m = result[colors[j]];
    owner[i] = j; m.coverage++; m.reach++;
    m.nodes += Number(s === engine._getPlayerStates(colors[j]).node);
  });
  const seen = new Uint8Array(n), queue = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (owner[start] >= 0 || seen[start]) continue;
    let tail = 1, mask = 0; queue[0] = start; seen[start] = 1;
    for (let head = 0; head < tail; head++) {
      let neighborsMask = 0;
      for (const next of engine._adjIdxList[queue[head]]) {
        if (owner[next] >= 0) neighborsMask |= 1 << owner[next];
        else if (!seen[next]) { seen[next] = 1; queue[tail++] = next; }
      }
      mask |= neighborsMask;
      colors.forEach((p, i) => { if (neighborsMask & (1 << i)) result[p].frontier++; });
    }
    colors.forEach((p, i) => { if (mask & (1 << i)) result[p].reach += tail; });
  }
  return result;
}

export function multiplayerMoveFeatures(engine, player, point, before, after, previous) {
  const n = engine.validPositions.length, r = engine.gridSize - 1;
  const opponents = engine.activePlayers.filter(p => p !== player && !engine.resignedPlayers.has(p));
  const own = after[player], max = f => Math.max(0, ...opponents.map(p => after[p][f]));
  const lost = f => opponents.reduce((v, p) => v + before[p][f] - after[p][f], 0);
  const home = engine.initialPositions[player], distance = (x, y) => Math.max(Math.abs(x), Math.abs(y), Math.abs(x + y));
  const hex = engine.boardShape === "hexagon";
  return [own.nodes/n, own.coverage/n, own.reach/n, (own.nodes-max("nodes"))/n,
    (own.coverage-max("coverage"))/n, (own.reach-max("reach"))/n, lost("nodes")/n,
    lost("coverage")/n, (own.nodes-before[player].nodes)/n, (own.coverage-before[player].coverage)/n,
    Number(opponents.some(p => previous === engine._getPlayerStates(p).line)),
    Number(previous === engine._getPlayerStates(player).line),
    distance(point[0]-home[0],point[1]-home[1])/(r*(hex?2:1)),
    hex ? 1-distance(point[0]-r,point[1]-r)/r : 3*Math.min(point[0],point[1],r-point[0]-point[1])/r,
    own.frontier/n, (own.frontier-max("frontier"))/n];
}

// No history set is copied at every search node. Roll back only newly appended
// hashes. A branch owns its grid/edges, and all callers restore in finally.
function checkpoint(engine) {
  return { grid: engine.grid, edges: engine.edges, historySize: engine.historyHashes.size,
    currentPlayer: engine.currentPlayer, gameOver: engine.gameOver, turnCount: engine.turnCount,
    consecutiveSkips: engine.consecutiveSkips, positionRevision: engine.positionRevision,
    territoryRevision: engine._territoryStateRevision };
}
function enter(engine) {
  const s = checkpoint(engine);
  engine.grid = new Map(engine.grid);
  engine.edges = Object.fromEntries(engine.activePlayers.map(p => [p, new Set(engine.edges[p])]));
  return s;
}
function leave(engine, s) {
  const hashes = [...engine.historyHashes];
  for (let i = s.historySize; i < hashes.length; i++) engine.historyHashes.delete(hashes[i]);
  Object.assign(engine, { grid: s.grid, edges: s.edges, currentPlayer: s.currentPlayer, gameOver: s.gameOver,
    turnCount: s.turnCount, consecutiveSkips: s.consecutiveSkips, positionRevision: s.positionRevision,
    _territoryStateRevision: s.territoryRevision });
}

const defaultFeatures = (engine, player, point, before, previous) =>
  multiplayerMoveFeatures(engine, player, point, before, multiplayerMetrics(engine), previous);

// The caller must own this engine. The public wrapper below creates a private
// search engine first. No history/board result cache survives an enumeration.
export function visitPolicyCandidates(engine, player, visit, {
  before = multiplayerMetrics(engine), beforeCandidate = null,
  featureReader = defaultFeatures, diagnostics = null
} = {}) {
  if (player !== engine.currentPlayer) throw new Error("Only the current player can be analysed");
  const sourceNodes = engine._getPlayerNodes(player), hashOrder = engine._getStateHashOrder();
  const originalHash = engine._computeStateHash;
  const descriptor = Object.getOwnPropertyDescriptor(engine, "_computeStateHash");
  const stats = diagnostics ?? {};
  Object.assign(stats, { potentialCandidates: 0, legalCandidates: 0, hashProbes: 0,
    superkoRejected: 0, sampledLegalPositions: 0, nodeEnumerations: 1, hashOrderEnumerations: 1 });
  let pending = null, features, readingFeatures = false;
  // Native _evaluateMove calls this only after its real _addNode succeeds.
  // Check exactly the same complete Superko hash before reading features; its
  // own history check remains authoritative, and only its legal result emits.
  // This avoids changing or copying GameEngine's rule implementation.
  engine._computeStateHash = function (nextPlayer, orderedPoints) {
    const identity = originalHash.call(this, nextPlayer, orderedPoints);
    if (pending && !readingFeatures) {
      pending.hashCalls++;
      if (pending.hashCalls !== 1 || this !== engine || orderedPoints !== hashOrder)
        throw new Error("Native move-probe hash contract changed");
      stats.hashProbes++;
      if (!this.historyHashes.has(identity)) {
        readingFeatures = true;
        try {
          features = featureReader(this, player, pending.point, before, pending.previous);
          stats.sampledLegalPositions++;
        } finally { readingFeatures = false; }
      }
    }
    return identity;
  };
  try {
    for (const point of potentialMoves(engine, player)) {
      beforeCandidate?.(point);
      stats.potentialCandidates++;
      pending = { point, previous: engine._getState(point), hashCalls: 0 }; features = undefined;
      const result = engine._evaluateMove(point, player, sourceNodes, hashOrder);
      pending = null;
      if (result.legal) {
        if (!Array.isArray(features) || features.length !== 16 || !features.every(Number.isFinite))
          throw new Error("Native probe did not produce the complete finite 16-feature vector");
        stats.legalCandidates++;
        visit({ point: [...point], features });
      } else {
        if (features !== undefined) throw new Error("Native probe legality changed after feature sampling");
        if (result.reason === "SUPERKO_VIOLATION") stats.superkoRejected++;
      }
    }
  } finally {
    pending = null;
    if (descriptor) Object.defineProperty(engine, "_computeStateHash", descriptor);
    else delete engine._computeStateHash;
  }
  return stats;
}

export function fastPolicyCandidates(source, player = source.currentPlayer, options = {}) {
  if (player !== source.currentPlayer) throw new Error("Only the current player can be analysed");
  const engine = isolatedSearchEngine(source), candidates = [];
  visitPolicyCandidates(engine, player, candidate => candidates.push(candidate), options);
  return candidates;
}

// Explicit opt-in: never invoke from a policy feature/hash callback. The root
// action must commit its real history and auto-skips before choosing the actual
// next responder. This checks ONE opponent, not a full multiplayer round or a
// forced cut chain. Existing metrics and 16-feature policies are unchanged.
export function probeMultiplayerReplyResilience(source, point, {
  maxReplies = 32, maxProbes = 256, timeMs = 25,
  now = () => performance.now(), deadline = null, followupMode = 'full',
} = {}) {
  if (![3, 4, 5, 6].includes(source.playerCount)
    || !['territory-v2', 'territory-v3'].includes(source.rulesVersion)
    || !Number.isInteger(source.gridSize) || source.gridSize < 5 || source.gridSize > 15
    || source.gameOver || source.resignedPlayers.has(source.currentPlayer)
    || !Number.isInteger(maxReplies) || maxReplies < 1
    || !Number.isInteger(maxProbes) || maxProbes < 1
    || !Number.isFinite(timeMs) || timeMs < 0 || typeof now !== 'function'
    || (deadline !== null && !Number.isFinite(deadline))
    || !['full', 'minimum', 'none'].includes(followupMode))
    throw new Error('Invalid bounded reply-resilience request');
  const started = now();
  if (!Number.isFinite(started)) throw new Error('Invalid reply-resilience clock');
  const end = Math.min(started + timeMs, deadline ?? Infinity);
  const STOP = Symbol('bounded reply-resilience');
  const result = { complete: false, reason: null, player: source.currentPlayer,
    rootPoint: point === null ? null : [...point], replyPlayer: null,
    repliesCompleted: 0, probes: 0, actions: 0, followupActions: 0, signal: null, worstReply: null,
    minimumFollowupCutNodes: null, allRepliesRetainFollowupCut: null,
    maximumNodeLoss: null, maximumCoverageLoss: null, allRepliesRetainAttackNode: null,
    rootWasAttack: null, minimumDefenseSignal: null, defenseWorstReply: null,
    minimumRetainedCapturedNodes: null, worstNetNodeGain: null, compositeSignalComplete: false,
    followupMode, conditionalFollowupComplete: false,
    scope: 'one-actual-next-opponent; conditional-actor-followup; topology-signal-only', terminalRoot: false };
  const checkBudget = () => {
    const time = now();
    if (!Number.isFinite(time)) throw new Error('Invalid reply-resilience clock');
    if (time >= end) { result.reason = 'deadline'; throw STOP; }
  };
  // Retain a single counter across every response and native auto-skip probe.
  const engine = isolatedSearchEngine(source), actor = source.currentPlayer;
  let knownZeroFollowup = false, omittedFollowups = false;
  const boundProbes = target => {
    const nativeEvaluate = target._evaluateMove;
    const descriptor = Object.getOwnPropertyDescriptor(target, '_evaluateMove');
    target._evaluateMove = function (...args) {
      checkBudget();
      if (result.probes >= maxProbes) { result.reason = 'probe-limit'; throw STOP; }
      result.probes++;
      const value = nativeEvaluate.apply(this, args);
      checkBudget(); return value;
    };
    return () => {
      if (descriptor) Object.defineProperty(target, '_evaluateMove', descriptor);
      else delete target._evaluateMove;
    };
  };
  const restoreEvaluate = boundProbes(engine);
  const nodeKeys = player => new Set(engine.validPositions
    .filter(p => engine._getState(p) === engine._getPlayerStates(player).node).map(key));
  const apply = (action, target = engine) => {
    checkBudget(); result.actions++;
    const outcome = action === null ? target.skipTurn() : target.playMove(action);
    checkBudget();
    if (!outcome.success) throw new Error(`Illegal reply-resilience action: ${outcome.reason}`);
  };
  const bestConditionalFollowup = () => {
    if (engine.gameOver || engine.resignedPlayers.has(actor)) return { nodes: 0, point: null };
    // Other seats have NOT been played. This answers only whether a legal new
    // cut exists if actor were to move on this stable physical/history state.
    // Never rewrite the real responder state or publish this as a forced line.
    // Reuse this probe's PRIVATE engine and restore the exact committed reply
    // in finally. Avoid rebuilding board geometry for every conditional cut;
    // the original caller and real responder state never escape this scope.
    const next = engine, replySnapshot = saveState(next);
    next.currentPlayer = actor;
    const start = saveState(next), opponents = next._getOpponents(actor);
    const enemyNodes = next.validPositions.flatMap(p => opponents.flatMap(player =>
      next._getState(p) === next._getPlayerStates(player).node ? [{ coordinate: key(p), player }] : []));
    const nodes = next._getPlayerNodes(actor), hashOrder = next._getStateHashOrder();
    let best = { nodes: 0, point: null };
    try {
      for (const candidate of potentialMoves(next, actor)) {
        checkBudget();
        if (!opponents.some(player => next._getState(candidate) === next._getPlayerStates(player).line)) continue;
        if (!next._evaluateMove(candidate, actor, nodes, hashOrder).legal) continue;
        result.followupActions++; apply(candidate, next);
        const captured = enemyNodes.filter(row => next.grid.get(row.coordinate) !== next._getPlayerStates(row.player).node).length;
        if (captured > best.nodes) best = { nodes: captured, point: [...candidate] };
        restoreState(next, start);
      }
      checkBudget(); return best;
    } finally { restoreState(next, replySnapshot); }
  };
  try {
    checkBudget();
    const enemyNodes = engine.activePlayers.filter(p => p !== actor && !engine.resignedPlayers.has(p))
      .flatMap(p => [...nodeKeys(p)].map(coordinate => ({ player: p, coordinate })));
    const isAttack = point !== null && engine._getOpponents(actor)
      .some(p => engine._getState(point) === engine._getPlayerStates(p).line);
    apply(point);
    const ownNodes = nodeKeys(actor);
    const ownStates = engine._getPlayerStates(actor);
    const ownCoverage = new Set(engine.validPositions.filter(p =>
      [ownStates.node, ownStates.line].includes(engine._getState(p))).map(key));
    const captured = enemyNodes.filter(row => engine.grid.get(row.coordinate) !== engine._getPlayerStates(row.player).node);
    const snapshot = saveState(engine);
    const measure = (withFollowup = true) => {
      checkBudget();
      const connected = engine._getOpponentConnectedPieces(actor);
      const retainedOwnNodes = [...ownNodes].filter(coordinate => connected.has(coordinate)
        && engine.grid.get(coordinate) === engine._getPlayerStates(actor).node).length;
      const retainedOwnCoverage = [...ownCoverage].filter(coordinate => connected.has(coordinate)
        && [ownStates.node, ownStates.line].includes(engine.grid.get(coordinate))).length;
      const retainedCapturedNodes = captured.filter(row =>
        engine.grid.get(row.coordinate) !== engine._getPlayerStates(row.player).node).length;
      const attackNodeSurvives = Boolean(isAttack && connected.has(key(point))
        && engine.grid.get(key(point)) === engine._getPlayerStates(actor).node);
      // Once an actually checked reply has no conditional cut, the minimum is
      // exactly zero. Later replies still undergo ALL native transitions and
      // defense measurements; only their now-irrelevant conditional cuts may
      // be skipped. Do not publish a composite min-score from these omissions.
      const omitFollowup = withFollowup && (followupMode === 'none' || (followupMode === 'minimum' && knownZeroFollowup));
      const followup = withFollowup && !omitFollowup ? bestConditionalFollowup() : { nodes: 0, point: null };
      omittedFollowups ||= omitFollowup;
      if (withFollowup && !omitFollowup && followup.nodes === 0) knownZeroFollowup = true;
      checkBudget();
      const defense = evaluateReplyResilience({ boardPointCount: engine.validPositions.length,
        ownNodesAfterRoot: ownNodes.size, retainedOwnNodes,
        capturedNodesAfterRoot: captured.length, retainedCapturedNodes, attackNodeSurvives });
      return { ...evaluateReplyResilience({ boardPointCount: engine.validPositions.length,
        ownNodesAfterRoot: ownNodes.size, retainedOwnNodes,
        capturedNodesAfterRoot: captured.length, retainedCapturedNodes, attackNodeSurvives,
        followupCutNodes: followup.nodes }), followupCutPoint: followup.point,
        retainedOwnCoverage, lostOwnCoverage: ownCoverage.size - retainedOwnCoverage,
        retainedCapturedNodes, defenseScore: defense.score };
    };
    result.terminalRoot = engine.gameOver;
    if (engine.gameOver || engine.currentPlayer === actor) {
      result.signal = measure(false); result.complete = true;
      result.reason = engine.gameOver ? 'terminal-root' : 'no-immediate-opponent';
      return result;
    }
    result.replyPlayer = engine.currentPlayer;
    let worst = null, defenseWorst = null, minimumFollowupCutNodes = Infinity;
    let maximumNodeLoss = 0, maximumCoverageLoss = 0, allRepliesRetainAttackNode = isAttack;
    let minimumRetainedCapturedNodes = Infinity;
    const evaluateReply = action => {
      let outcome;
      if (action === null) {
        outcome = engine.skipTurn();
      } else {
        // potentialMoves supplies only necessary geometric candidates. Commit
        // the native transition once and let its real legality/Superko result
        // decide membership; probing with _evaluateMove and then playMove
        // repeated the same crawl/hash work for every legal reply.
        checkBudget();
        if (result.probes >= maxProbes) { result.reason = 'probe-limit'; throw STOP; }
        result.probes++;
        outcome = engine.playMove(action);
      }
      checkBudget();
      if (!outcome.success) {
        restoreState(engine, snapshot);
        if (action !== null && ['INVALID_MOVE', 'SUPERKO_VIOLATION'].includes(outcome.reason)) return false;
        throw new Error(`Illegal reply-resilience action: ${outcome.reason}`);
      }
      if (result.repliesCompleted >= maxReplies) { result.reason = 'reply-limit'; throw STOP; }
      result.actions++;
      const signal = measure();
      result.repliesCompleted++;
      minimumFollowupCutNodes = Math.min(minimumFollowupCutNodes, signal.followupCutNodes);
      maximumNodeLoss = Math.max(maximumNodeLoss, signal.lostOwnNodes);
      maximumCoverageLoss = Math.max(maximumCoverageLoss, signal.lostOwnCoverage);
      minimumRetainedCapturedNodes = Math.min(minimumRetainedCapturedNodes, signal.retainedCapturedNodes);
      allRepliesRetainAttackNode &&= signal.attackNodeSurvives;
      if (worst === null || signal.score < worst.signal.score)
        worst = { action: action === null ? null : [...action], signal };
      if (defenseWorst === null || signal.defenseScore < defenseWorst.signal.defenseScore)
        defenseWorst = { action: action === null ? null : [...action], signal };
      restoreState(engine, snapshot);
      return true;
    };
    // No top-K reply filter: low policy-score cuts, repairs and PASS remain in
    // the domain. Exhaustion returns no score, never a partial optimistic min.
    for (const reply of potentialMoves(engine, result.replyPlayer)) {
      checkBudget();
      evaluateReply(reply);
    }
    evaluateReply(null);
    checkBudget(); result.complete = true; result.reason = 'complete';
    result.compositeSignalComplete = !omittedFollowups;
    result.signal = omittedFollowups ? null : worst.signal;
    result.worstReply = omittedFollowups ? null : worst.action;
    result.conditionalFollowupComplete = followupMode !== 'none';
    result.minimumFollowupCutNodes = followupMode === 'none' ? null : minimumFollowupCutNodes;
    result.allRepliesRetainFollowupCut = followupMode === 'none' ? null : minimumFollowupCutNodes >= 1;
    result.maximumNodeLoss = maximumNodeLoss; result.maximumCoverageLoss = maximumCoverageLoss;
    result.allRepliesRetainAttackNode = allRepliesRetainAttackNode; result.rootWasAttack = isAttack;
    result.minimumDefenseSignal = defenseWorst.signal.defenseScore;
    result.defenseWorstReply = defenseWorst.action;
    result.minimumRetainedCapturedNodes = minimumRetainedCapturedNodes;
    result.worstNetNodeGain = minimumRetainedCapturedNodes - maximumNodeLoss;
  } catch (error) {
    if (error !== STOP) throw error;
  } finally {
    restoreEvaluate();
    result.elapsedMs = now() - started;
  }
  return result;
}

export function relativeUtility(engine, player, metrics = multiplayerMetrics(engine)) {
  const others = engine.activePlayers.filter(p => p !== player && !engine.resignedPlayers.has(p));
  const strength = p => 15*metrics[p].nodes + 8*metrics[p].coverage + 20*metrics[p].reach;
  return (strength(player) - Math.max(0, ...others.map(strength))) / engine.validPositions.length;
}

export class MultiplayerMinimaxAI {
  constructor({ depth = 3, timeMs = 700, weights = null, rootPrior = null, pruning = true, nodeBudget = Infinity, exactScores = false, priorWeight = 0, allowPass = true } = {}) {
    this.depth = depth; this.timeMs = timeMs; this.weights = weights; this.rootPrior = rootPrior;
    this.pruning = pruning; this.nodeBudget = nodeBudget;
    this.exactScores = exactScores; this.priorWeight = priorWeight;
    this.allowPass = allowPass;
  }
  getTopMoves(source, player = source.currentPlayer, topN = 5) {
    if (!["territory-v2", "territory-v3"].includes(source.rulesVersion) || source.currentPlayer !== player) throw new Error("Invalid multiplayer search state");
    const started = performance.now(), deadline = started + this.timeMs;
    const engine = isolatedSearchEngine(source);
    const stats = this.lastSearch = { nodes: 0, cutoffs: 0, completedDepth: 0, elapsedMs: 0, timedOut: false,
      candidateCap: null, algorithm: "paranoid-alpha-beta", partialIterationDiscarded: false, terminalScoringInterrupted:false };
    const check = () => { if (performance.now() >= deadline || stats.nodes >= this.nodeBudget) throw TIMEOUT; };
    const terminalCache = new Map();
    const actions = () => [...potentialMoves(engine), ...(this.allowPass && !engine.gameOver ? [null] : [])];
    const apply = point => point===null ? engine.skipTurn() : engine.playMove(point);
    const evaluate = () => {
      if (!engine.gameOver) return relativeUtility(engine, player);
      const position = engine._computeStateHash(engine.currentPlayer);
      if (terminalCache.has(position)) return terminalCache.get(position);
      // Exact scoring for confirmed terminal leaves, never fast reach as area.
      // Poll at the isolated coordinate index: contour/path validation and
      // flood-fill coverage consult it throughout the scorer. Keep all engine
      // method identities intact so its proven native-path pruning stays on.
      // This wrapper cannot escape the isolated engine or survive an exception.
      const index=engine._keyToIdx, originalGet=index.get;
      let probes=0;
      index.get=function(k){if((++probes&63)===0)check();return originalGet.call(this,k);};
      try { check();GameEngine.prototype._updateTerritories.call(engine);check(); }
      catch(error){if(error===TIMEOUT)stats.terminalScoringInterrupted=true;throw error;}
      finally { delete index.get; }
      const remaining = engine.activePlayers.filter(p => !engine.resignedPlayers.has(p));
      const max = Math.max(...remaining.map(p => engine.cachedTerritories[p].area));
      const winners = remaining.filter(p => engine.cachedTerritories[p].area === max);
      const value = winners.includes(player) ? 100000 / winners.length : -100000;
      terminalCache.set(position, value); return value;
    };
    const rank = (points, actor, preferred) => points.map(point => {
      const state = point===null?0:engine._getState(point), own = engine._getPlayerStates(actor);
      let score = state && state !== own.line ? 1000 : state === own.line ? 1 : 0;
      if (preferred?.point && key(point) === key(preferred.point)) score += 10000;
      return { point, score };
    }).sort((a,b) => b.score-a.score || order(a,b));
    const visit = (depth, alpha, beta) => {
      check(); stats.nodes++;
      if (depth === 0 || engine.gameOver) return evaluate();
      const actor = engine.currentPlayer, maximizing = actor === player;
      let best = maximizing ? -Infinity : Infinity, found = false;
      for (const move of rank(actions(), actor)) {
        check(); const s = enter(engine);
        try {
          if (!apply(move.point).success) continue;
          found = true;
          const value = visit(depth-1, alpha, beta);
          best = maximizing ? Math.max(best,value) : Math.min(best,value);
          if (maximizing) alpha = Math.max(alpha,best); else beta = Math.min(beta,best);
        } finally { leave(engine,s); }
        if (this.pruning && beta <= alpha) { stats.cutoffs++; break; }
      }
      if (!found) {
        const s = enter(engine);
        try { engine.skipTurn(); return visit(depth-1,alpha,beta); }
        finally { leave(engine,s); }
      }
      return best;
    };
    let completed = [], roots = rank(actions(), player);
    try {
      // Establish legal root alternatives first. Emit an incumbent before any
      // deeper iteration; deadline checks occur between canonical transitions.
      const before = multiplayerMetrics(engine);
      for (const move of roots) {
        if (completed.length) check();
        const previous = move.point===null?0:engine._getState(move.point), s = enter(engine);
        try {
          if (!apply(move.point).success) continue;
          const metrics = multiplayerMetrics(engine);
          const features = move.point===null?Array(16).fill(0):multiplayerMoveFeatures(engine,player,move.point,before,metrics,previous);
          const policy = this.weights ? features.reduce((v,x,i) => v+x*this.weights[i],0) : 0;
          const prior = this.rootPrior?.get(key(move.point)) ?? 0;
          // Establish a legal, cheaply evaluated incumbent before entering the
          // exact terminal scorer, which can itself exhaust the time budget.
          const score = relativeUtility(engine,player,metrics) + this.priorWeight*prior;
          completed.push({ point:move.point===null?null:[...move.point], score, policy, prior, features,
            terminal:engine.gameOver, scoreBound:"heuristic" });
        } finally { leave(engine,s); }
      }
      completed.sort((a,b) => b.score-a.score || b.policy-a.policy || b.prior-a.prior || order(a,b));
      const firstIteration=[];
      for(const move of completed){
        let score=move.score;
        if(move.terminal){
          check();const s=enter(engine);
          try {
            if(!apply(move.point).success)throw new Error("Legal root changed during isolated search");
            score=evaluate()+this.priorWeight*move.prior;
          }finally{leave(engine,s);}
        }
        firstIteration.push({...move,score,scoreBound:"exact"});
      }
      firstIteration.sort((a,b) => b.score-a.score || b.policy-a.policy || b.prior-a.prior || order(a,b));
      completed=firstIteration;
      stats.completedDepth = 1;
      for (let depth = 2; depth <= this.depth && completed.length; depth++) {
        const iteration = []; let alpha = -Infinity;
        for (const move of completed) {
          check(); const s = enter(engine);
          try {
            if (!apply(move.point).success) throw new Error("Legal root changed during isolated search");
            const bias = this.priorWeight*move.prior;
            const window = this.exactScores || !this.pruning ? -Infinity : alpha-bias;
            const score = visit(depth-1,window,Infinity)+bias;
            iteration.push({ ...move, score, scoreBound:score<=alpha && window!==-Infinity ? "upper" : "exact" });
            alpha=Math.max(alpha,score);
          } finally { leave(engine,s); }
        }
        iteration.sort((a,b) => b.score-a.score || Number(a.scoreBound==="upper")-Number(b.scoreBound==="upper") || b.policy-a.policy || b.prior-a.prior || order(a,b));
        completed = iteration; stats.completedDepth = depth;
      }
    } catch (error) {
      if (error !== TIMEOUT) throw error;
      stats.timedOut = true; stats.partialIterationDiscarded = stats.completedDepth > 0;
      if(stats.completedDepth===0) completed.sort((a,b) => b.score-a.score || b.policy-a.policy || b.prior-a.prior || order(a,b));
    } finally { stats.elapsedMs = performance.now()-started; }
    return completed.slice(0,topN).map(({ point, score, policy, prior, scoreBound="exact" }) => ({ type:point===null?"pass":"move", point, score, policy, prior, scoreBound, visits:1 }));
  }
}
