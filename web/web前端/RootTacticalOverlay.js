import { computeRootStability } from "./RootStability.js?v=20261029-unified-r1";
import { computeEncirclementFeatures } from "./EncirclementFeatures.js?v=20261029-unified-r1";

const LIMIT = Symbol("root-tactical-budget");
const clock = () => globalThis.performance?.now?.() ?? Date.now();

// Narrow correction to an existing policy's first two candidates. This checks
// the actual next surviving actor and Superko, not a fictional coalition.
// It is a one-reply screen, not a proof of future safety or forced attack.
export function applyRootTacticalOverlay(engine, player, ranked, { deadline = clock() + 200 } = {}) {
  const original = [...ranked];
  const receipt = { status: "preserved", complete: false, candidates: 0, scope: "next-actor-cut-and-pass" };
  if (engine.isTopologyBoard || original.length < 2 || original[0]?.point == null
      || original[1]?.point == null || engine.gameOver || engine.currentPlayer !== player) {
    return { moves: original, receipt: { ...receipt, status: "not-applicable" } };
  }
  const originalState = engine._captureReplayState();
  const originalBatch = engine._isReplayingBatch, originalDefer = engine.deferTerritoryUpdates;
  const check = () => { if (clock() >= deadline) throw LIMIT; };
  const examine = (move) => {
    check();
    engine._restoreReplayState(originalState);
    if (!engine.playMove(move.point).success) throw new Error("Policy produced an illegal candidate");
    check();
    // PASS or a self-turn following automatic skips requires a full terminal
    // comparison, which this narrow screen intentionally does not claim.
    if (engine.gameOver || engine.currentPlayer === player || engine.consecutiveSkips > 0) throw LIMIT;
    const actor = engine.currentPlayer;
    const stable = computeRootStability(engine, player).nodeCount;
    const ownNodes = engine._getPlayerNodes(player).length;
    const enemyNodes = engine.activePlayers.filter(other => other !== player && !engine.resignedPlayers.has(other))
      .reduce((sum, other) => sum + engine._getPlayerNodes(other).length, 0);
    const encirclement = computeEncirclementFeatures(engine, player, check);
    const afterCandidate = engine._captureReplayState();
    let worstNodes = ownNodes, replies = 0;
    // A direct blocking attack on this player's line is the only placement
    // that can remove that player's existing nodes on this single reply.
    for (const point of engine._getPlayerLines(player)) {
      check();
      engine._restoreReplayState(afterCandidate);
      if (!engine._evaluateMove(point, actor).legal) continue;
      engine._restoreReplayState(afterCandidate);
      if (!engine.playMove(point).success) throw new Error("Validated tactical reply failed");
      check();
      worstNodes = Math.min(worstNodes, engine._getPlayerNodes(player).length);
      replies += 1;
    }
    engine._restoreReplayState(afterCandidate);
    check();
    // Preserve the actual PASS transition, including skips and terminal state.
    if (!engine.skipTurn().success) throw new Error("Tactical PASS failed");
    check();
    if (engine.gameOver) throw LIMIT;
    worstNodes = Math.min(worstNodes, engine._getPlayerNodes(player).length);
    return { stable, ownNodes, enemyNodes, worstNodes, encirclement, replies: replies + 1 };
  };
  try {
    engine._isReplayingBatch = true;
    engine.deferTerritoryUpdates = true;
    const first = examine(original[0]);
    const second = examine(original[1]);
    receipt.complete = true;
    receipt.candidates = 2;
    receipt.first = first;
    receipt.second = second;
    // Never exchange material or a better verified response for a certificate.
    // Stable nodes are a sufficient subset, not the number of safe nodes.
    if (second.ownNodes >= first.ownNodes && second.enemyNodes <= first.enemyNodes
        && second.worstNodes >= first.worstNodes
        && second.encirclement.pressure >= first.encirclement.pressure
        && (second.worstNodes > first.worstNodes || second.stable > first.stable
          || second.encirclement.pressure > first.encirclement.pressure)) {
      [original[0], original[1]] = [original[1], original[0]];
      receipt.status = "selected-verified-improvement";
    } else receipt.status = "preserved-no-dominance";
  } catch (error) {
    // A failed speculative screen must not turn an otherwise valid policy
    // decision into a worker failure; leave the original ranking untouched.
    receipt.status = error === LIMIT ? "preserved-budget-or-unsupported-position" : "preserved-probe-error";
  } finally {
    engine._restoreReplayState(originalState);
    engine._isReplayingBatch = originalBatch;
    engine.deferTerritoryUpdates = originalDefer;
  }
  return { moves: original, receipt };
}
