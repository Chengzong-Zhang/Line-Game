import { rankTopologyCandidates, TOPOLOGY_AI_PASS } from "./TopologyAIAdapter.js?v=20261029-unified-r1";
import { computeRootStability } from "./RootStability.js?v=20261029-unified-r1";
import { computeEncirclementFeatures } from "./EncirclementFeatures.js?v=20261029-unified-r1";

const now = () => globalThis.performance?.now?.() ?? Date.now();
const LIMIT = Symbol("topology-search-budget");

/**
 * Bounded Max-n search using the real quotient-board rules, including PASS,
 * cuts, disconnection and Superko. Two players reduce to a zero-sum search.
 * Only a fully visited iteration may advertise a completed depth. A bounded
 * partial first iteration is identified as such, never presented as a model
 * or a strength-verified policy.
 */
export function searchTopologyMoves(engine, options = {}) {
  if (!engine?.isTopologyBoard) throw new TypeError("Topology search requires a topology engine.");
  const aiPlayer = options.aiPlayer ?? engine.currentPlayer;
  if (engine.gameOver || engine.currentPlayer !== aiPlayer) {
    throw new Error("Topology search requires the current player in an unfinished game.");
  }
  const started = now();
  const timeLimitMs = Math.max(25, Math.min(5000, Number(options.timeLimitMs) || 3000));
  const deadline = Number.isFinite(options.deadline) ? options.deadline : started + timeLimitMs;
  const maxNodes = Math.max(1, Math.min(50000, Math.floor(Number(options.maxNodes) || 50000)));
  const maxDepth = Math.max(1, Math.min(12, Math.floor(Number(options.maxDepth) || 2)));
  const topN = Math.max(1, Math.min(10, Math.floor(Number(options.topN) || 1)));
  const stabilityWeight = Number.isFinite(options.stabilityWeight) ? options.stabilityWeight : 100;
  const original = engine._captureTopologyState();
  const originalBatch = engine._isReplayingBatch;
  const originalDefer = engine.deferTerritoryUpdates;
  const hadOwnHasValidMoves = Object.hasOwn(engine, "_hasValidMoves");
  const originalHasValidMoves = engine._hasValidMoves;
  const players = [...engine.activePlayers];
  const playerIndex = new Map(players.map((player, index) => [player, index]));
  const aiIndex = playerIndex.get(aiPlayer);
  let nodes = 0;
  let completedDepth = 0;
  let budgetExceeded = false;
  let rootCount = 0;
  let completed = [];
  let partial = [];
  let legalRoots = [];
  let firstLegalRoot = null;
  let legalEnumerationComplete = false;
  let partialIterationDiscarded = false;
  let opponentActions = 0;
  let maxOpponentActionsOnVisitedPath = 0;
  const opponentActionCounts = new Map(players.filter(player => player !== aiPlayer
    && !engine.resignedPlayers.has(player)).map(player => [player, 0]));
  let maxOpponentRoundsOnVisitedPath = 0;
  const checkBudget = () => {
    if (nodes >= maxNodes || now() >= deadline) throw LIMIT;
  };
  const evaluate = () => {
    checkBudget();
    if (engine.hasPendingTerritoryUpdate()) engine._updateTerritories();
    checkBudget();
    const scores = engine.getScoreboard();
    checkBudget();
    const survivors = new Set(engine._getRemainingPlayers());
    const winner = engine.gameOver ? engine.getWinner() : null;
    return players.map((player) => {
      if (!survivors.has(player)) return -1e8;
      if (winner && winner !== "DRAW") return winner === player ? 1e8 : -1e8;
      const strongestOpponent = Math.max(0, ...players
        .filter((other) => other !== player && survivors.has(other))
        .map((other) => scores[other]?.area ?? 0));
      // A sufficient certificate, not a verdict on uncertified nodes. This is
      // only a nonterminal preference and never changes official area.
      const stableNodes = engine.gameOver || stabilityWeight === 0 ? 0 : computeRootStability(engine, player).nodeCount;
      checkBudget();
      const pressure = engine.gameOver ? 0 : computeEncirclementFeatures(engine, player, checkBudget).pressure;
      return 1000 * ((scores[player]?.area ?? 0) - strongestOpponent)
        + stabilityWeight * stableNodes + 50 * pressure + (engine.gameOver ? 0 : engine._getPlayerNodes(player).length);
    });
  };
  const orderedActions = () => {
    const actor = engine.currentPlayer;
    const legal = [];
    for (const vertexId of engine.validPositions) {
      checkBudget();
      const result = engine._evaluateMove(vertexId, actor);
      if (result.legal) {
        legal.push({ vertexId, isAttack: result.isAttack });
        if (actor === aiPlayer && firstLegalRoot == null) firstLegalRoot = vertexId;
      }
    }
    checkBudget();
    const priorities = new Map(legal.map((move) => [move.vertexId, move.isAttack ? 1 : 0]));
    const ordered = rankTopologyCandidates(engine.compiledBoard, legal.map((move) => move.vertexId), {
      anchorVertexIds: engine._getPlayerNodes(actor),
    }).map((move) => move.vertexId);
    checkBudget();
    ordered.sort((a, b) => priorities.get(b) - priorities.get(a));
    // PASS is a real root/recursive choice, even when placements exist.
    return [...ordered, TOPOLOGY_AI_PASS];
  };
  const withAction = (action, visit) => {
    const state = engine._captureTopologyState();
    const actor = engine.currentPlayer;
    const isOpponentAction = actor !== aiPlayer;
    let counted = false;
    try {
      const result = action === TOPOLOGY_AI_PASS ? engine.skipTurn() : engine.playMove(action);
      if (!result.success) throw new Error("Search generated an illegal topology action: " + result.reason);
      nodes += 1;
      if (isOpponentAction) {
        opponentActions++;
        opponentActionCounts.set(actor, (opponentActionCounts.get(actor) ?? 0) + 1);
        counted = true;
      }
      maxOpponentActionsOnVisitedPath = Math.max(maxOpponentActionsOnVisitedPath, opponentActions);
      if (opponentActionCounts.size) {
        maxOpponentRoundsOnVisitedPath = Math.max(maxOpponentRoundsOnVisitedPath,
          Math.min(...opponentActionCounts.values()));
      }
      return visit();
    } finally {
      if (counted) { opponentActions--; opponentActionCounts.set(actor, opponentActionCounts.get(actor) - 1); }
      engine._restoreTopologyState(state);
    }
  };
  const descend = (depth) => {
    checkBudget();
    if (engine.gameOver || depth === 0) return evaluate();
    const actorIndex = playerIndex.get(engine.currentPlayer);
    const actions = orderedActions();
    let best = null;
    for (const action of actions) {
      checkBudget();
      const value = withAction(action, () => descend(depth - 1));
      if (best == null || value[actorIndex] > best[actorIndex]) best = value;
    }
    return best ?? evaluate();
  };
  const sortResults = (results) => results.sort((a, b) => b.score - a.score || a.order - b.order);
  try {
    engine._isReplayingBatch = true;
    engine.deferTerritoryUpdates = true;
    // Auto-skip invokes the same expensive legality search during playMove and
    // PASS. Permit cancellation between probes without changing game rules.
    engine._hasValidMoves = function (player) {
      for (const vertexId of this.validPositions) {
        checkBudget();
        if (this._evaluateMove(vertexId, player).legal) return true;
      }
      return false;
    };
    try {
      legalRoots = orderedActions();
      legalEnumerationComplete = true;
    } catch (error) {
      if (error !== LIMIT) throw error;
      budgetExceeded = true;
      // A deadline is not a decision to PASS. Use only a placement already
      // validated against the complete current history, or return no result.
      legalRoots = firstLegalRoot == null ? [] : [firstLegalRoot];
    }
    rootCount = legalRoots.length;
    // Check a winning terminal PASS before spending the search budget. It is
    // an explicit simulated win, never a timeout/no-result substitution.
    if (!budgetExceeded && engine.consecutiveSkips >= engine._getRemainingPlayers().length - 1) {
      let winsByPass = false;
      try {
        checkBudget();
        winsByPass = withAction(TOPOLOGY_AI_PASS, () => {
          checkBudget();
          const won = engine.gameOver && engine.getWinner() === aiPlayer;
          checkBudget();
          return won;
        });
      } catch (error) {
        if (error !== LIMIT) throw error;
        budgetExceeded = true;
      }
      if (winsByPass) {
        completed = [{ action: TOPOLOGY_AI_PASS, score: 1e8, order: rootCount - 1 }];
      }
    }
    if (!completed.length && !budgetExceeded) {
      for (let depth = 1; depth <= maxDepth; depth += 1) {
        const iteration = [];
        const iterationStartNodes = nodes;
        try {
          for (let order = 0; order < legalRoots.length; order += 1) {
            checkBudget();
            const action = legalRoots[order];
            const value = withAction(action, () => descend(depth - 1));
            iteration.push({ action, score: value[aiIndex], order });
          }
          completed = sortResults(iteration);
          completedDepth = depth;
        } catch (error) {
          if (error !== LIMIT) throw error;
          budgetExceeded = true;
          if (!completed.length) partial = sortResults(iteration);
          else partialIterationDiscarded = nodes > iterationStartNodes;
          break;
        }
      }
    }
    const candidates = completed.length ? completed : partial;
    // A legal placement found by the complete rule generator is a safe
    // fallback. Missing/failed worker results are handled separately as errors.
    const fallback = candidates.length ? candidates : legalRoots.length
      ? [{ action: legalRoots[0], score: null, order: 0 }] : [];
    const moves = fallback.slice(0, topN).map(({ action, score }) => action === TOPOLOGY_AI_PASS
      ? { type: "pass", point: null, score }
      : { type: "move", point: action, vertexId: action, score });
    return {
      moves,
      searchInfo: {
        algorithm: "bounded-max-n-v1",
        completedDepth,
        requestedDepth: maxDepth,
        nodes,
        maxOpponentActionsOnVisitedPath,
        maxOpponentRoundsOnVisitedPath,
        rootCount,
        evaluatedRoots: completedDepth ? rootCount : partial.length,
        budgetExceeded,
        legalEnumerationComplete,
        partialIterationDiscarded,
        selective: completedDepth === 0 && !completed.length,
        fallback: !completed.length,
        fallbackReason: !completed.length ? (partial.length ? "partial-first-iteration"
          : legalRoots.length ? "legal-action-after-budget" : "no-action-before-budget") : null,
        terminalPassWin: completedDepth === 0 && completed[0]?.action === TOPOLOGY_AI_PASS,
        elapsedMs: Math.round((now() - started) * 100) / 100,
        strengthVerified: false,
      },
    };
  } finally {
    engine._restoreTopologyState(original);
    engine._isReplayingBatch = originalBatch;
    engine.deferTerritoryUpdates = originalDefer;
    if (hadOwnHasValidMoves) engine._hasValidMoves = originalHasValidMoves;
    else delete engine._hasValidMoves;
  }
}
