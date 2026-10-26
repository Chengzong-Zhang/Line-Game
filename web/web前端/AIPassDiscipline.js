// Product decision guard. A complete opponent-round witness is deliberately
// not a deep Minimax label or a guarantee against later opponent rounds.
import { GameEngine } from "./GameEngine.js?v=20261026-start-protection-v1";
import { saveState, restoreState } from "./AIEngine.js?v=20261026-start-protection-v1";
import { isolatedSearchEngine } from "./MultiplayerSearch.js?v=20261026-start-protection-v1";
import { multiplayerClock } from "./MultiplayerClock.js?v=20261026-start-protection-v1";

export const PASS_DISCIPLINE_CONTRACT = Object.freeze({
  schema: "lifeline-ai-pass-discipline-v1",
  safetyScope: "root placement and all legal action sequences including PASS through one complete actual opponent round, ending at the actor's next turn or native terminal; canonical auto-skips",
  terminalPass: "winning alone never bypasses the policy; prefer a witnessed strictly profitable native-area expansion",
  openingPass: "prefer witnessed intact development with native area nondecreasing during the first two seat rounds",
  timeout: "incomplete proof preserves a real policy PASS; missing policy output is never converted to voluntary PASS",
  training: "one-complete-opponent-round runtime evidence only; labels still require independently completed >=3-ply/two-round Minimax",
});
const key = point => point === null ? "PASS" : point.join(",");
const check = (ok, message) => { if (!ok) throw new Error(message); };
const BUDGET = Symbol("PASS discipline proof budget");

// v3's official score is exactly this native wall-count function. Avoiding its
// separate polygon construction changes no score. Older rules retain their
// native territory implementation. No cache, board, edge or history is written.
export function nativeDiscreteAreas(engine, players = engine.activePlayers) {
  const pieces = Object.fromEntries(engine.activePlayers.map(player => [player,
    [...engine._getPlayerNodes(player), ...engine._getPlayerLines(player)]]));
  return Object.fromEntries(players.map(player => {
    const area = engine.rulesVersion === "territory-v3"
      ? GameEngine.prototype._computeOwnedWallArea.call(engine, pieces[player], engine._getOpponents(player).flatMap(other => pieces[other]))
      : GameEngine.prototype._computeTerritory.call(engine, player).area;
    check(Number.isInteger(area) && area >= 0, "PASS discipline requires native discrete area");
    return [player, area];
  }));
}
function ownPieces(engine, player) {
  const nodes = new Set(engine._getPlayerNodes(player).map(key));
  return { nodes, coverage: new Set([...nodes, ...engine._getPlayerLines(player).map(key)]) };
}
const contains = (all, required) => [...required].every(point => all.has(point));
const margin = (areas, engine, actor) => areas[actor] - Math.max(0, ...engine.activePlayers
  .filter(player => player !== actor && !engine.resignedPlayers.has(player)).map(player => areas[player]));

export function assessPassAlternatives(source, player = source.currentPlayer, {
  preferredMoves = [], timeMs = 200, maxNodes = 10000, now = () => multiplayerClock.now(),
} = {}) {
  check(player === source.currentPlayer && !source.resignedPlayers.has(player), "PASS discipline requires the actual current actor");
  check(Number.isFinite(timeMs) && timeMs >= 0 && Number.isInteger(maxNodes) && maxNodes >= 0, "Invalid PASS discipline proof budget");
  const started = now(); check(Number.isFinite(started), "Invalid PASS discipline clock");
  const receipt = { schema: PASS_DISCIPLINE_CONTRACT.schema, status: "no-certified-expansion", complete: false,
    actor: player, rulesVersion: source.rulesVersion, positionRevision: source.positionRevision,
    safetyScope: PASS_DISCIPLINE_CONTRACT.safetyScope, examinedRoots: 0, nodes: 0,
    legalPlacements: 0, rootsExhausted: false, witness: null, elapsedMs: 0, reason: null };
  const finish = (status, reason) => {
    receipt.status = status; receipt.reason = reason; receipt.elapsedMs = now() - started; return receipt;
  };
  if (source.gameOver) { receipt.complete = true; return finish("game-over", "terminal-source"); }
  const budget = () => {
    const time = now(); if (!Number.isFinite(time) || time - started >= timeMs || receipt.nodes >= maxNodes) throw BUDGET;
  };
  try {
    budget();
    const engine = isolatedSearchEngine(source), original = saveState(engine);
    const legal = engine.getLegalMoves(player).map(move => [...move.point]); receipt.legalPlacements = legal.length;
    if (!legal.length) { receipt.complete = true; receipt.rootsExhausted = true; return finish("forced-pass", "no-canonical-legal-placement"); }
    budget();
    const before = ownPieces(engine, player), beforeAreas = nativeDiscreteAreas(engine), beforeArea = beforeAreas[player];
    budget();
    check(engine.skipTurn().success, "Canonical nonterminal PASS failed");
    const passWouldEnd = engine.gameOver;
    const passAreas = passWouldEnd ? nativeDiscreteAreas(engine) : null;
    const passMargin = passWouldEnd ? margin(passAreas, engine, player) : null;
    const opening = !passWouldEnd && source.turnCount < 2 * source.activePlayers.filter(p => !source.resignedPlayers.has(p)).length;
    receipt.passWouldEnd = passWouldEnd; receipt.beforeArea = beforeArea; receipt.openingDevelopmentEligible = opening;
    const preferred = preferredMoves.filter(move => Array.isArray(move?.point)).map(move => key(move.point));
    const roots = [...legal].sort((a, b) => {
      const ai = preferred.indexOf(key(a)), bi = preferred.indexOf(key(b));
      return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || a[1] - b[1] || a[0] - b[0];
    });
    for (const point of roots) {
      budget(); restoreState(engine, original); receipt.examinedRoots++; receipt.nodes++;
      check(engine.playMove(point).success, "PASS discipline root ceased to be legal"); budget();
      const after = ownPieces(engine, player), connected = engine._getOpponentConnectedPieces(player);
      if (!contains(after.nodes, before.nodes) || !contains(after.coverage, before.coverage)
        || !contains(connected, after.nodes)) continue;
      const afterRootArea = nativeDiscreteAreas(engine, [player])[player]; budget();
      const strictGain = afterRootArea > beforeArea;
      const development = opening && afterRootArea >= beforeArea && after.nodes.size > before.nodes.size;
      if (!strictGain && !development) continue;
      const replyPlayer = !engine.gameOver && engine.currentPlayer !== player ? engine.currentPlayer : null;
      let minimumArea = Infinity, minimumMargin = Infinity, completed = 0, total = 0,
        maxReplyPlies = 0, leaves = 0;
      const replyActors = new Set();
      const inspect = () => {
        budget();
        const retained = ownPieces(engine, player), rooted = engine._getOpponentConnectedPieces(player);
        if (!contains(retained.nodes, after.nodes) || !contains(retained.coverage, after.coverage)
          || !contains(rooted, retained.nodes)) return false;
        // Every occupied friendly point contributes to v3's formal area. This
        // lower bound is sufficient only when it proves the requested gain.
        const lowerBound = engine.rulesVersion === "territory-v3" && retained.coverage.size > beforeArea
          ? retained.coverage.size : nativeDiscreteAreas(engine, [player])[player];
        minimumArea = Math.min(minimumArea, lowerBound);
        if (passWouldEnd && passMargin >= 0) {
          const currentMargin = margin(nativeDiscreteAreas(engine), engine, player);
          minimumMargin = Math.min(minimumMargin, currentMargin);
          if (passMargin > 0 ? currentMargin <= 0 : currentMargin < 0) return false;
        }
        budget();
        return strictGain ? lowerBound > beforeArea : lowerBound >= beforeArea;
      };
      const proveRound = (depth, branchActors) => {
        if (!inspect()) return false;
        maxReplyPlies = Math.max(maxReplyPlies, depth);
        if (engine.gameOver || engine.currentPlayer === player) { leaves++; return true; }
        const actor = engine.currentPlayer;
        // A repeated opponent means the original actor was auto-skipped. We
        // cannot certify a finite round ending at its next actual turn by
        // inspecting just the first cycle, so reject this root conservatively.
        if (branchActors.has(actor)) return false;
        const visited = new Set(branchActors); visited.add(actor); replyActors.add(actor);
        budget();
        const replies = [...engine.getLegalMoves(actor).map(move => [...move.point]), null];
        const state = saveState(engine); total += replies.length; budget();
        for (const reply of replies) {
          budget(); restoreState(engine, state); receipt.nodes++;
          check(engine.currentPlayer === actor, "PASS discipline fabricated the reply actor");
          check((reply === null ? engine.skipTurn() : engine.playMove(reply)).success, "PASS discipline reply ceased to be legal");
          completed++;
          if (!proveRound(depth + 1, visited)) return false;
        }
        return true;
      };
      const safe = proveRound(0, new Set());
      if (!safe) continue;
      budget();
      receipt.complete = true;
      receipt.witness = { point: [...point], beforeArea, afterRootArea, minimumReplyAreaLowerBound: minimumArea,
        profitKind: strictGain ? "strict-native-area-gain" : "opening-node-development-area-nondecreasing",
        rootNodesRetained: true, rootCoverageRetained: true, rootConnected: true,
        preservesAllAfterRootNodesAndCoverage: true, actualReplyPlayer: replyPlayer,
        replyPlies: maxReplyPlies, maxReplyPlies, actualReplyActors: [...replyActors],
        replyActionsCompleted: completed, replyActionsTotal: total, replyLeavesCompleted: leaves,
        replyWindow: "one-complete-actual-opponent-round", completeOpponentRound: true,
        includesPass: replyActors.size > 0, complete: true, passWouldEnd,
        minimumReplyMargin: Number.isFinite(minimumMargin) ? minimumMargin : null,
        scope: PASS_DISCIPLINE_CONTRACT.safetyScope };
      return finish("safe-profitable-expansion", replyPlayer ? "complete-actual-opponent-round-domain" : "canonical-terminal-or-auto-skipped-to-actor");
    }
    receipt.complete = true; receipt.rootsExhausted = true;
    return finish("no-certified-expansion", "all-legal-roots-rejected-by-bounded-safety-contract");
  } catch (error) {
    if (error !== BUDGET) throw error;
    return finish("incomplete", "proof-budget-exhausted-no-safety-claim");
  }
}

export function applyPassDiscipline(source, rankedMoves, { player = source.currentPlayer, topN = 5, ...options } = {}) {
  const requested = Math.max(0, Math.floor(topN));
  if (!requested || source.gameOver) return { moves: [], receipt: { schema: PASS_DISCIPLINE_CONTRACT.schema,
    status: source.gameOver ? "game-over" : "not-requested", witness: null } };
  check(player === source.currentPlayer && !source.resignedPlayers.has(player), "PASS discipline actor mismatch");
  const original = Array.isArray(rankedMoves) ? rankedMoves : [];
  if (Array.isArray(original[0]?.point)) return { moves: original.slice(0, requested),
    receipt: { schema: PASS_DISCIPLINE_CONTRACT.schema, status: "placement-policy-preserved", witness: null } };
  check(!original.length || original[0]?.point === null, "AI returned an invalid action instead of an explicit placement/PASS");
  const receipt = assessPassAlternatives(source, player, { ...options, preferredMoves: original });
  if (receipt.status === "forced-pass") return { moves: [{ type: "pass", point: null, score: 0, visits: 1,
    evaluation: "canonical-forced-pass" }], receipt };
  if (receipt.status === "safe-profitable-expansion") {
    const point = receipt.witness.point, existing = original.find(move => Array.isArray(move.point) && key(move.point) === key(point));
    const selected = existing ? { ...existing } : { type: "move", point: [...point], score: receipt.witness.minimumReplyAreaLowerBound - receipt.witness.beforeArea, visits: 1 };
    selected.passDiscipline = { schema: receipt.schema, status: receipt.status, profitKind: receipt.witness.profitKind };
    return { moves: [selected, ...original.filter(move => key(move.point) !== key(point))].slice(0, requested), receipt };
  }
  if (original.length) return { moves: original.slice(0, requested), receipt };
  const error = new Error("AI 未给出可靠行动，请重试；当前棋局已保留。");
  error.code = "AI_NO_RELIABLE_ACTION"; error.passDiscipline = receipt; throw error;
}

export function withPassDiscipline(policy) {
  if (policy?.passDisciplineContract === PASS_DISCIPLINE_CONTRACT.schema) return policy;
  return { passDisciplineContract: PASS_DISCIPLINE_CONTRACT.schema, lastSearch: null,
    getTopMoves(source, player = source.currentPlayer, topN = 5, options = {}) {
      // Request a few placement alternatives without reducing any search
      // depth/iteration budget. They only order the separate proof roots.
      const ranked = policy.getTopMoves(source, player, topN > 0 ? Math.max(5, topN) : topN, options);
      const result = options.passDisciplinePrechecked === true ? { moves: ranked, receipt: null }
        : applyPassDiscipline(source, ranked, { player, topN });
      this.lastSearch = { ...(policy.lastSearch ?? {}), ...(result.receipt ? { passDiscipline: result.receipt } : {}) };
      return result.moves;
    } };
}
