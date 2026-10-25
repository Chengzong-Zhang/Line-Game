import { portableClone as structuredClone } from './PortableClone.js';
import { multiplayerClock as performance } from "./MultiplayerClock.js";
// Hard V2 application factory. Registration and qualification remain external.
import { MultiplayerRolloutAI as Candidate } from "./MultiplayerHardRollout.js?v=20261024-hard-cut-resilience3";
import { HardDeadlineFallbackV2 } from "./MultiplayerHardFallback.js?v=20261024-hard-cut-resilience3";
import { isolatedSearchEngine, potentialMoves, probeMultiplayerReplyResilience } from "./MultiplayerSearch.js";
import { compareCompletedReplyResilience } from "./MultiplayerHardValue.js";
import { saveState, restoreState } from "./AIEngine.js";

export const HARD_EXPERIMENT_OPTIONS = Object.freeze({ timeMs: 650, rolloutPlies: Object.freeze([12,24]),
  minimumImprovement: .02, candidateCap: null, allowPass: true, rootPriors: null });
export const HARD_REPLY_WINDOW_MS = 220;
const pointKey = point => point === null ? "PASS" : point.join(",");
const copyPoint = point => point === null ? null : [...point];
const responseScope = "one-actual-next-opponent; conditional-actor-followup; topology-signal-only";
const packetSummary = packet => ({ point: copyPoint(packet.rootPoint), replyPlayer: packet.replyPlayer,
  repliesCompleted: packet.repliesCompleted, maximumNodeLoss: packet.maximumNodeLoss,
  maximumCoverageLoss: packet.maximumCoverageLoss, rootWasAttack: packet.rootWasAttack,
  allRepliesRetainAttackNode: packet.allRepliesRetainAttackNode,
  minimumFollowupCutNodes: packet.minimumFollowupCutNodes,
  allRepliesRetainFollowupCut: packet.allRepliesRetainFollowupCut,
  conditionalFollowupComplete: packet.conditionalFollowupComplete,
  minimumRetainedCapturedNodes: packet.minimumRetainedCapturedNodes, worstNetNodeGain: packet.worstNetNodeGain,
  minimumDefenseSignal: packet.minimumDefenseSignal });

// Root order may use a complete native scan of immediate direct cuts. For each
// tactical root, commit the real transition, enumerate every legal cut by the
// actual next responder, and measure its worst immediate node/coverage loss.
// This bounded scan publishes no move. A later root is still eligible only
// after its full MOVE+PASS response domain completes in the main probe.
function scanTacticalDirectCutRisk(source, roots, { deadline, now = () => performance.now(),
  measurePlacementKeys = new Set() }) {
  const actor = source.currentPlayer, engine = isolatedSearchEngine(source), rootSnapshot = saveState(engine);
  const stats = { complete: false, reason: null, probes: 0, rootsChecked: 0, terminalRoot: null, rows: [] };
  const STOP = Symbol('Hard tactical-ordering deadline');
  const check = () => {
    const time = now();
    if (!Number.isFinite(time)) throw new Error('Invalid tactical-ordering clock');
    if (time >= deadline) throw STOP;
  };
  const evaluate = engine._evaluateMove;
  const descriptor = Object.getOwnPropertyDescriptor(engine, '_evaluateMove');
  engine._evaluateMove = function(...args) {
    check(); stats.probes++;
    const result = evaluate.apply(this, args);
    check(); return result;
  };
  try {
    const enemies = engine.activePlayers.filter(player => player !== actor && !engine.resignedPlayers.has(player));
    const enemyNodes = enemies.flatMap(player => engine.validPositions
      .filter(point => engine._getState(point) === engine._getPlayerStates(player).node)
      .map(point => ({ player, coordinate: pointKey(point) })));
    const byPoint = new Map();
    for (const root of roots) {
      check(); restoreState(engine, rootSnapshot);
      stats.rootsChecked++;
      const outcome = root.point === null ? engine.skipTurn() : engine.playMove(root.point);
      check();
      if (!outcome.success) throw new Error(`Illegal Hard tactical-order root: ${outcome.reason}`);
      if (engine.gameOver) {
        stats.complete = true; stats.reason = 'terminal-requires-native-score';
        stats.terminalRoot = { point: copyPoint(root.point) };
        return { byPoint, stats };
      }
      // Ordinary placements need only the exact native terminal check, except
      // when one is the fixed entry anchor. Tactical candidates are compared
      // against that anchor, so omitting its risk row would make every such
      // position fail closed before the new defence/PASS layer can run.
      if (root.kind === 'placement' && !measurePlacementKeys.has(pointKey(root.point))) continue;
      const own = engine._getPlayerStates(actor);
      const ownNodes = new Set(engine.validPositions
        .filter(point => engine._getState(point) === own.node).map(pointKey));
      const ownCoverage = new Set(engine.validPositions
        .filter(point => [own.node, own.line].includes(engine._getState(point))).map(pointKey));
      const capturedNodes = enemyNodes.filter(row =>
        engine.grid.get(row.coordinate) !== engine._getPlayerStates(row.player).node).length;
      const row = { point: copyPoint(root.point), replyPlayer: null, directCutReplies: 0,
        maximumNodeLoss: 0, maximumCoverageLoss: 0, capturedNodes, worstNetNodeGain: capturedNodes,
        terminalRoot: false };
      if (engine.currentPlayer !== actor) {
        row.replyPlayer = engine.currentPlayer;
        const replySnapshot = saveState(engine);
        for (const reply of potentialMoves(engine, row.replyPlayer)) {
          check();
          if (engine._getState(reply) !== own.line) continue;
          stats.probes++;
          const replyOutcome = engine.playMove(reply);
          check();
          if (!replyOutcome.success) {
            restoreState(engine, replySnapshot);
            if (['INVALID_MOVE', 'SUPERKO_VIOLATION'].includes(replyOutcome.reason)) continue;
            throw new Error(`Illegal Hard tactical-order reply: ${replyOutcome.reason}`);
          }
          row.directCutReplies++;
          const connected = engine._getOpponentConnectedPieces(actor);
          const retainedNodes = [...ownNodes].filter(coordinate => connected.has(coordinate)
            && engine.grid.get(coordinate) === own.node).length;
          const retainedCoverage = [...ownCoverage].filter(coordinate => connected.has(coordinate)
            && [own.node, own.line].includes(engine.grid.get(coordinate))).length;
          row.maximumNodeLoss = Math.max(row.maximumNodeLoss, ownNodes.size - retainedNodes);
          row.maximumCoverageLoss = Math.max(row.maximumCoverageLoss, ownCoverage.size - retainedCoverage);
          restoreState(engine, replySnapshot);
        }
      }
      row.worstNetNodeGain = row.capturedNodes - row.maximumNodeLoss;
      stats.rows.push(row); byPoint.set(pointKey(root.point), row);
    }
    check();
    stats.complete = true; stats.reason = 'complete';
    return { byPoint, stats };
  } catch (error) {
    if (error !== STOP) throw error;
    stats.reason = 'deadline';
    return { byPoint: new Map(), stats };
  } finally {
    restoreState(engine, rootSnapshot);
    if (descriptor) Object.defineProperty(engine, '_evaluateMove', descriptor); else delete engine._evaluateMove;
  }
}

// An unvisited immediate terminal root must not be masked by an earlier
// topology improvement. Exhaustively commit each root using native transitions
// before tactical publication is even eligible. Exact winner scoring remains
// the responsibility of the original rollout path.
export function preflightImmediateTerminalRoots(source, roots, { deadline, now = () => performance.now() }) {
  const stats = { complete: false, terminalRoot: null, attemptedRoots: 0, reason: null };
  const engine = isolatedSearchEngine(source), snapshot = saveState(engine), STOP = Symbol('terminal preflight deadline');
  const check = () => { const time = now(); if (!Number.isFinite(time)) throw new Error('Invalid terminal preflight clock');
    if (time >= deadline) throw STOP; };
  const evaluate = engine._evaluateMove, descriptor = Object.getOwnPropertyDescriptor(engine, '_evaluateMove');
  engine._evaluateMove = function(...args) { check(); const value = evaluate.apply(this, args); check(); return value; };
  try {
    for (const root of roots) {
      check(); stats.attemptedRoots++;
      const outcome = root.point === null ? engine.skipTurn() : engine.playMove(root.point);
      check();
      if (!outcome.success) throw new Error(`Illegal Hard terminal preflight root: ${outcome.reason}`);
      if (engine.gameOver) {
        stats.terminalRoot = { point: copyPoint(root.point) };
        stats.reason = 'terminal-requires-native-score'; return stats;
      }
      restoreState(engine, snapshot);
    }
    check(); stats.complete = true; stats.reason = 'complete'; return stats;
  } catch (error) {
    if (error !== STOP) throw error;
    stats.reason = 'deadline'; return stats;
  } finally {
    if (descriptor) Object.defineProperty(engine, '_evaluateMove', descriptor); else delete engine._evaluateMove;
  }
}

// This stage changes root ordering, not the full-ranking contract or legal
// reply domain. A root is publishable only after ALL actual next-opponent
// MOVE+PASS responses finish. Conditional cut bonuses require a separate
// complete check for both tied roots; unknown never means zero. Incomplete
// challengers never replace the best earlier completed packet.
export function selectCompleteReplyResilience(source, { anchor, fullRanking, deadline,
  windowMs = HARD_REPLY_WINDOW_MS, now = () => performance.now(),
  probe = probeMultiplayerReplyResilience, preflight = preflightImmediateTerminalRoots } = {}) {
  const started = now(), end = Math.min(deadline, started + windowMs);
  const stats = { scope: responseScope, windowMs, absoluteDeadline: end, elapsedMs: 0,
    reason: "no-complete-ranking", accepted: false, selected: null, anchor: null,
    candidateReachability: [], attemptedRoots: [], completedRoots: [], followupAttempts: [],
    partialRootDiscarded: false, completeRootDomain: false, orderingRiskScan: null, terminalPreflight: null };
  let selected = null, anchorPacket = null;
  try {
    if (!Number.isFinite(started) || !Number.isFinite(deadline)
      || !Number.isFinite(windowMs) || windowMs < 0) throw new Error("Invalid Hard reply deadline");
    if (!anchor || !Array.isArray(fullRanking)) return { moves: null, stats };
    const roots = [...fullRanking];
    if (!roots.some(move => move.point === null)) roots.push({ point: null });
    if (!roots.some(move => pointKey(move.point) === pointKey(anchor.point)))
      throw new Error("Hard reply anchor missing from complete root domain");
    const own = source._getPlayerStates(source.currentPlayer);
    const enemyLines = new Set(source._getOpponents(source.currentPlayer).map(player => source._getPlayerStates(player).line));
    const kind = point => point === null ? "pass" : enemyLines.has(source._getState(point))
      ? "attack" : source._getState(point) === own.line ? "reinforcement" : "placement";
    const indexed = roots.map((move, rank) => ({ point: copyPoint(move.point), rank, kind: kind(move.point) }));
    const anchorRoot = indexed.find(move => pointKey(move.point) === pointKey(anchor.point));
    const others = indexed.filter(move => move !== anchorRoot);
    // Keep the complete legal root inventory observable even if the bounded
    // ordering/terminal scan closes before risk ordering is available.
    const provisionalOrder = [anchorRoot, ...others.filter(move => move.kind === 'pass'),
      ...others.filter(move => move.kind !== 'pass')];
    stats.candidateReachability = provisionalOrder.map((move, visitOrder) => ({ ...move, visitOrder,
      directCutPriority: false, directCutRisk: null }));
    const riskScan = scanTacticalDirectCutRisk(source, indexed, { deadline: end, now,
      measurePlacementKeys: new Set([pointKey(anchorRoot.point)]) });
    stats.orderingRiskScan = riskScan.stats;
    if (!riskScan.stats.complete) { stats.reason = riskScan.stats.reason; return { moves: null, stats }; }
    if (riskScan.stats.terminalRoot !== null) {
      stats.terminalPreflight = { complete: false, terminalRoot: riskScan.stats.terminalRoot,
        attemptedRoots: riskScan.stats.rootsChecked, reason: 'terminal-requires-native-score',
        reusedOrderingScan: true };
      stats.reason = 'terminal-requires-native-score'; return { moves: null, stats };
    }
    const risk = move => riskScan.byPoint.get(pointKey(move.point));
    const compareDirectRisk = (left, right) => left.maximumNodeLoss - right.maximumNodeLoss
      || right.worstNetNodeGain - left.worstNetNodeGain
      || left.maximumCoverageLoss - right.maximumCoverageLoss;
    const rankedTactical = others.filter(move => move.kind !== 'placement' && move.kind !== 'pass')
      .sort((left, right) => compareDirectRisk(risk(left), risk(right)) || left.rank - right.rank);
    // Keep the fixed entry anchor first. At most one genuinely safer direct-cut
    // response precedes PASS, so neither a long attack list nor low model rank
    // can make the relevant repair or PASS unreachable in the short window.
    const priority = rankedTactical.find(move => compareDirectRisk(risk(move), risk(anchorRoot)) < 0) ?? null;
    const passes = others.filter(move => move.kind === 'pass');
    const ordered = [anchorRoot, ...(priority ? [priority] : []), ...passes,
      ...rankedTactical.filter(move => move !== priority),
      ...others.filter(move => move.kind === 'placement')];
    if (new Set(ordered.map(move => pointKey(move.point))).size !== ordered.length)
      throw new Error("Duplicate Hard reply roots");
    stats.candidateReachability = ordered.map((move, visitOrder) => ({ ...move, visitOrder,
      directCutPriority: move === priority,
      directCutRisk: riskScan.byPoint.has(pointKey(move.point)) ? {
        maximumNodeLoss: risk(move).maximumNodeLoss, maximumCoverageLoss: risk(move).maximumCoverageLoss,
        worstNetNodeGain: risk(move).worstNetNodeGain, directCutReplies: risk(move).directCutReplies,
      } : null }));
    stats.terminalPreflight = preflight === preflightImmediateTerminalRoots
      ? { complete: true, terminalRoot: null, attemptedRoots: riskScan.stats.rootsChecked,
        reason: 'complete', reusedOrderingScan: true }
      : preflight(source, ordered, { deadline: end, now });
    if (!stats.terminalPreflight.complete || stats.terminalPreflight.terminalRoot !== null) {
      stats.reason = stats.terminalPreflight.reason; return { moves: null, stats };
    }
    stats.reason = "no-strict-improvement";
    for (const root of ordered) {
      const remaining = end - now();
      if (remaining <= 0) { stats.reason = "deadline"; break; }
      const attempt = { point: copyPoint(root.point), rank: root.rank, kind: root.kind, complete: false };
      stats.attemptedRoots.push(attempt);
      let packet = probe(source, root.point, { deadline: end, timeMs: remaining, now,
        maxReplies: source.validPositions.length + 1, maxProbes: 16384, followupMode: 'none' });
      Object.assign(attempt, { complete: packet.complete && packet.reason === "complete",
        reason: packet.reason, repliesCompleted: packet.repliesCompleted, probes: packet.probes });
      // Native terminal scoring belongs to the existing exact terminal path.
      // It must never lose to a nonterminal topology packet from this stage.
      if (packet.terminalRoot) { selected = null; stats.reason = "terminal-requires-native-score"; break; }
      if (!attempt.complete) {
        stats.partialRootDiscarded = true;
        if (!stats.anchor || packet.reason === "deadline") { stats.reason = packet.reason; break; }
        continue;
      }
      // Validate even the first anchor before retaining or comparing it.
      compareCompletedReplyResilience(packet, packet);
      if (pointKey(packet.rootPoint) !== pointKey(root.point) || packet.player !== source.currentPlayer)
        throw new Error("Hard reply packet belongs to another root or actor");
      const summary = packetSummary(packet);
      stats.completedRoots.push(summary);
      if (!stats.anchor) { stats.anchor = summary; selected = packet; anchorPacket = packet; }
      else {
        let comparison = compareCompletedReplyResilience(packet, selected, { anchor: anchorPacket });
        // Conditional chain search only matters for equally safe, equally
        // profitable surviving attacks. A worse defense cannot buy acceptance
        // with a speculative second cut, and unknown followups are never zero.
        const defenseTied = ['maximumNodeLoss', 'maximumCoverageLoss', 'worstNetNodeGain', 'allRepliesRetainAttackNode']
          .every(name => packet[name] === selected[name]);
        if (comparison === 0 && defenseTied && packet.rootWasAttack && selected.rootWasAttack
          && packet.allRepliesRetainAttackNode && packet.minimumRetainedCapturedNodes > 0) {
          const extend = prior => {
            if (prior.conditionalFollowupComplete || now() >= end) return prior;
            const extended = probe(source, prior.rootPoint, { deadline: end, timeMs: Math.max(0, end - now()), now,
              maxReplies: source.validPositions.length + 1, maxProbes: 16384, followupMode: 'minimum' });
            stats.followupAttempts.push({ point: copyPoint(prior.rootPoint), complete: extended.complete,
              reason: extended.reason, repliesCompleted: extended.repliesCompleted });
            if (!extended.complete || extended.reason !== 'complete') { stats.partialRootDiscarded = true; return prior; }
            compareCompletedReplyResilience(extended, extended);
            if (pointKey(extended.rootPoint) !== pointKey(prior.rootPoint) || extended.player !== prior.player
              || ['maximumNodeLoss', 'maximumCoverageLoss', 'worstNetNodeGain', 'allRepliesRetainAttackNode']
                .some(name => extended[name] !== prior[name])) throw new Error('Conditional replay changed complete defense packet');
            return extended;
          };
          selected = extend(selected);
          if (selected.conditionalFollowupComplete) packet = extend(packet);
          comparison = compareCompletedReplyResilience(packet, selected, { anchor: anchorPacket });
        }
        if (comparison > 0) selected = packet;
      }
    }
    stats.completeRootDomain = stats.completedRoots.length === ordered.length;
    stats.accepted = selected !== null && pointKey(selected.rootPoint) !== pointKey(anchor.point);
    stats.selected = selected ? packetSummary(selected) : null;
    if (stats.accepted && stats.reason === 'no-strict-improvement') stats.reason = 'complete-improvement';
    if (!stats.accepted) return { moves: null, stats };
    return { moves: [{ type: selected.rootPoint === null ? "pass" : "move", point: copyPoint(selected.rootPoint),
      score: selected.minimumDefenseSignal, prior: 1, visits: selected.repliesCompleted,
      evaluation: "complete-next-opponent-resilience" }], stats };
  } catch (error) {
    // A faulty probe cannot publish earlier tactical improvements. Preserve the
    // original path, with its remaining shared deadline, and record the failure.
    stats.reason = "error"; stats.error = { name: error.name, message: error.message };
    stats.accepted = false; stats.selected = null;
    return { moves: null, stats };
  } finally { stats.elapsedMs = now() - started; }
}

export function createHardRuntimeV2(engine, medium) {
  if (![3,4,5,6].includes(engine.playerCount)
    || !Number.isInteger(engine.gridSize) || engine.gridSize < 5 || engine.gridSize > 15
    || !["territory-v2", "territory-v3"].includes(engine.rulesVersion) || engine.boardShape !== (engine.playerCount === 3 ? "triangle" : "hexagon"))
    throw new Error("Unsupported isolated Hard v2 experiment configuration");
  const fallback = new HardDeadlineFallbackV2(medium.policySpec, {
    searchV4: medium.modelInfo.id === "three-player-search-v4-round12",
  });
  const ai = {
    ...HARD_EXPERIMENT_OPTIONS, lastSearch: null, fallbackPolicy: fallback,
    getTopMoves(source, player = source.currentPlayer, topN = 5) {
      const started = performance.now(), deadline = started + this.timeMs;
      this.lastSearch = { algorithm: "hard-complete-next-opponent-resilience-v1", elapsedMs: 0,
        absoluteDeadline: deadline, fallbackChanged: false, partial: false, baselineComplete: false };
      if (source.gameOver || topN <= 0) return [];
      let search = null, tactical = null;
      try {
        const moves = fallback.getTopMoves(source, player, Math.max(1, topN), { deadline });
        const fallbackMs = performance.now() - started;
        if (performance.now() >= deadline) {
          this.lastSearch = { ...this.lastSearch, fallbackMs, usedFallback: true, timedOut: true,
            legalRoots: null, completedRootComparisons: 0, completedPhases: [],
            selectedEvaluation: "fallback-only", decisionSource: fallback.lastSearch.decisionSource };
          return moves;
        }
        if (fallback.lastSearch.baselineComplete) {
          tactical = selectCompleteReplyResilience(source, { anchor: moves[0],
            fullRanking: fallback.fullRanking, deadline });
          if (tactical.moves) {
            this.lastSearch = { ...this.lastSearch, fallbackMs, usedFallback: false,
              selectedEvaluation: "complete-next-opponent-resilience",
              decisionSource: "completed-reply-resilience-comparisons",
              legalRoots: tactical.stats.candidateReachability.length,
              completedRootComparisons: Math.max(0, tactical.stats.completedRoots.length - 1),
              completedPhases: [] };
            // An accepted all-reply packet is final for this turn; the older
            // single-policy continuation cannot overwrite its defense result.
            const selectedKey = pointKey(tactical.moves[0].point);
            return [...tactical.moves, ...moves.filter(move => pointKey(move.point) !== selectedKey)]
              .slice(0, Math.max(1, Math.floor(topN)));
          }
        }
        const readyFallback = { getTopMoves: () => moves };
        // Reuse only the complete unchanged LINEAR ranking. A v4 shortlist or
        // interrupted enumeration must never claim the full-ranking contract.
        if (!fallback.searchV4 && fallback.lastSearch.baselineComplete) {
          readyFallback.fullRankingContract = { kind: "multiplayer-linear-full-ranking", version: 1, spec: medium.policySpec };
          readyFallback.getFullRanking = () => fallback.fullRanking;
        }
        search = new Candidate({ basePolicy: medium.policySpec, responsePolicies: [medium.policySpec],
          fallbackPolicy: readyFallback, timeMs: this.timeMs, rolloutPlies: [12,24], publishCompletedComparisons: true });
        search.absoluteDeadline = deadline;
        const result = search.getTopMoves(source, player, topN);
        this.lastSearch = { ...search.lastSearch, absoluteDeadline: deadline, fallbackMs,
          decisionSource: search.lastSearch.selectedEvaluation === "fallback-only"
            ? fallback.lastSearch.decisionSource : search.lastSearch.decisionSource };
        return result;
      } catch (error) {
        this.lastSearch.error = { name: error.name, message: error.message };
        throw error;
      } finally {
        const details = fallback.lastSearch;
        this.lastSearch = { ...this.lastSearch, algorithm: "hard-complete-next-opponent-resilience-v1",
          elapsedMs: performance.now() - started, fallbackSearch: structuredClone(details),
          tacticalSearch: tactical?.stats ?? null,
          baselineComplete: details?.baselineComplete ?? false, fallbackChanged: details?.fallbackChanged ?? false,
          partial: Boolean(details?.partial || search?.lastSearch?.timedOut || this.lastSearch.timedOut),
          timedOut: Boolean(details?.timedOut || this.lastSearch.timedOut) };
      }
    },
  };
  return { ai, modelInfo: { implementationId: "multiplayer-hard-cut-resilience-v1", baseSourceManifestSha256: "8d89b9074be7a79b706a345eedfeda2d174337061e9424ebe8ff526ba41668bc",
    evidenceTier: "unqualified-application-algorithm-candidate", lineage: medium.modelInfo.id,
    nonterminalEvaluation: "multiplayer-heuristic-value-v2", terminalEvaluation: `native-${engine.rulesVersion}`,
    publicationMode: "completed-comparisons", absoluteDeadlineMs: 650,
    tacticalAlgorithm: "lexicographic-complete-next-opponent-resilience-v1", responseScope,
    fallbackPolicy: "interruptible-original-v4-or-linear; explicit-partial-linear-or-deadline-pass",
    strengthPreservationClaim: false } };
}
