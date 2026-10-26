// Product-only bounded structural precheck. V1/V2 and training remain frozen.
import { applyPassDiscipline as applyV2, protectedRootInvariantHolds,
  passDisciplineStateHash, nativeDiscreteAreas } from "./AIPassDisciplineV2.js?v=20261026-start-protection-v1";
import { saveState, restoreState } from "./AIEngine.js?v=20261026-start-protection-v1";
import { isolatedSearchEngine } from "./MultiplayerSearch.js?v=20261026-start-protection-v1";
import { multiplayerClock } from "./MultiplayerClock.js?v=20261026-start-protection-v1";

export const PASS_DISCIPLINE_CONTRACT = Object.freeze({
  schema: "lifeline-ai-pass-discipline-v3",
  quickProof: "Explicit policy PASS and canonical nonterminal PASS only: at most 12 roots by birth distance; structural root search uses at most min(8ms, 5% of total proof budget); isolation and canonical PASS preflight use the shared total budget",
  safetyScope: "Same v3 immutable birth-root protection invariant as V2, through arbitrary opponent-only legal action sequences until the actor next acts or resigns, or native terminal; no reply enumeration claimed",
  budget: "Certificate hashes use the total proof budget; no certificate on exhaustion. Unproved quick probes pass only actual remaining total time/nodes to unchanged V2. Policy/Minimax search budgets are unaffected.",
});
export { nativeDiscreteAreas };
const key = point => point === null ? "PASS" : point.join(",");
const own = (engine, actor) => ({ nodes: new Set(engine._getPlayerNodes(actor).map(key)),
  coverage: new Set([...engine._getPlayerNodes(actor), ...engine._getPlayerLines(actor)].map(key)) });
const TIMEOUT = Symbol("v3 shared proof budget"), QUICK_DONE = Symbol("v3 bounded structural probe");

export function applyPassDiscipline(source, rankedMoves, { player = source.currentPlayer, topN = 5,
  timeMs = 200, maxNodes = 10000, now = () => multiplayerClock.now(), ...options } = {}) {
  const original = Array.isArray(rankedMoves) ? rankedMoves : [], requested = Math.max(0, Math.floor(topN));
  const legacy = extra => applyV2(source, original, { ...options, player, topN, timeMs, maxNodes, now, ...extra });
  if (!requested || source.gameOver || source.rulesVersion !== "territory-v3" || original[0]?.type !== "pass"
    || original[0]?.point !== null || player !== source.currentPlayer || source.resignedPlayers.has(player)
    || !Number.isFinite(timeMs) || timeMs < 0 || !Number.isInteger(maxNodes) || maxNodes < 0) return legacy();
  const started = now(); if (!Number.isFinite(started)) return legacy();
  const quickBudgetMs = Math.min(8, timeMs * 0.05);
  let quickStarted = null, setupAndPassElapsedMs = 0;
  let nodes = 0, rootsExamined = 0, quickElapsedMs = 0, quickStatus = "no-structural-certificate";
  const elapsed = () => { const time = now(); if (!Number.isFinite(time)) throw new Error("Invalid PASS discipline clock"); return time - started; };
  const totalBudget = () => { if (elapsed() >= timeMs || nodes >= maxNodes) throw TIMEOUT; };
  const quickBudget = () => { totalBudget(); if (elapsed() - setupAndPassElapsedMs >= quickBudgetMs) throw QUICK_DONE; };
  const fallback = () => {
    const spent = elapsed(), result = legacy({ timeMs: Math.max(0, timeMs - spent), maxNodes: Math.max(0, maxNodes - nodes) });
    return { ...result, receipt: { ...result.receipt, productQuickProbe: { schema: PASS_DISCIPLINE_CONTRACT.schema,
      status: quickStatus, budgetMs: quickBudgetMs, elapsedMs: quickElapsedMs, setupAndPassElapsedMs, rootsExamined, nodes } } };
  };
  try {
    totalBudget();
    const engine = isolatedSearchEngine(source), initial = saveState(engine);
    totalBudget(); nodes++;
    if (!engine.skipTurn().success) throw new Error("Canonical nonterminal PASS failed");
    totalBudget();
    if (engine.gameOver) { quickStatus = "terminal-PASS-retains-V2-margin"; setupAndPassElapsedMs = elapsed(); return fallback(); }
    restoreState(engine, initial);
    quickStarted = now(); setupAndPassElapsedMs = quickStarted - started;
    const before = own(engine, player), beforeArea = nativeDiscreteAreas(engine, [player])[player];
    const birth = engine.initialPositions[player];
    const distance = point => Math.max(Math.abs(point[0] - birth[0]), Math.abs(point[1] - birth[1]),
      Math.abs(point[0] - birth[0] + point[1] - birth[1]));
    // Do not enumerate all legal moves before the bounded quick probe: that
    // would spend its budget before reaching the first nearby root. Candidate
    // placements are independently accepted/rejected by canonical playMove.
    const lineStates = new Set(engine.activePlayers.map(actor => engine._getPlayerStates(actor).line));
    const roots = engine.validPositions.filter(point => engine._getState(point) === 0
      || lineStates.has(engine._getState(point))).map(point => [...point]).sort((a, b) =>
      distance(a) - distance(b) || a[1] - b[1] || a[0] - b[0]).slice(0, 12);
    quickBudget();
    for (const point of roots) {
      quickBudget(); restoreState(engine, initial); nodes++; rootsExamined++;
      const result = engine.playMove(point);
      quickBudget();
      if (!result.success) continue;
      if (!protectedRootInvariantHolds(engine, player, before, beforeArea)) continue;
      quickBudget(); quickElapsedMs = elapsed() - setupAndPassElapsedMs; quickStatus = "certified-immutable-root";
      // The structural search is complete. Hash formatting is separately
      // charged to the shared total deadline, never to fictional reply probes.
      totalBudget();
      const sourceStateHash = passDisciplineStateHash(source), postRootStateHash = passDisciplineStateHash(engine);
      totalBudget();
      const coverage = own(engine, player).coverage.size;
      const receipt = { schema: PASS_DISCIPLINE_CONTRACT.schema, status: "safe-profitable-expansion", complete: true,
        actor: player, rulesVersion: source.rulesVersion, positionRevision: source.positionRevision,
        sourceStateHash, passWouldEnd: false, nodes, setupAndPassElapsedMs, quickBudgetMs, quickElapsedMs, totalElapsedMs: elapsed(),
        elapsedMs: elapsed(), rootsExamined, safetyScope: PASS_DISCIPLINE_CONTRACT.safetyScope,
        witness: { point: [...point], beforeArea, minimumReplyAreaLowerBound: coverage,
          profitKind: "strict-native-area-gain", proofType: "immutable-birth-root-protection-invariant",
          proofOrder: "bounded-structural-precheck-before-V2", beforeNodesRetained: true, beforeCoverageRetained: true,
          allPostRootNodesBirthConnected: true, allPostRootLinesBirthProtected: true, birth: [...birth],
          postRootCoverage: coverage, sourceStateHash, postRootStateHash, completeOpponentRound: false,
          scope: PASS_DISCIPLINE_CONTRACT.safetyScope } };
      const existing = original.find(move => Array.isArray(move.point) && key(move.point) === key(point));
      const selected = existing ? { ...existing } : { type: "move", point: [...point], score: coverage - beforeArea, visits: 1 };
      selected.passDiscipline = { schema: receipt.schema, status: receipt.status, profitKind: receipt.witness.profitKind,
        proofType: receipt.witness.proofType };
      return { moves: [selected, ...original.filter(move => key(move.point) !== key(point))].slice(0, requested), receipt };
    }
    quickElapsedMs = elapsed() - setupAndPassElapsedMs; return fallback();
  } catch (error) {
    if (error !== TIMEOUT && error !== QUICK_DONE) throw error;
    quickStatus = error === TIMEOUT ? "total-budget-exhausted" : "quick-budget-exhausted";
    if (quickStarted === null) { setupAndPassElapsedMs = elapsed(); quickElapsedMs = 0; }
    else quickElapsedMs = elapsed() - setupAndPassElapsedMs;
    return fallback();
  }
}

export function withPassDiscipline(policy) {
  if (policy?.passDisciplineContract === PASS_DISCIPLINE_CONTRACT.schema) return policy;
  return { passDisciplineContract: PASS_DISCIPLINE_CONTRACT.schema, lastSearch: null,
    getTopMoves(source, player = source.currentPlayer, topN = 5, options = {}) {
      const ranked = policy.getTopMoves(source, player, topN > 0 ? Math.max(5, topN) : topN,
        { ...options, passDisciplinePrechecked: true });
      const result = options.passDisciplinePrechecked === true ? { moves: ranked, receipt: null }
        : applyPassDiscipline(source, ranked, { player, topN });
      this.lastSearch = { ...(policy.lastSearch ?? {}), ...(result.receipt ? { passDiscipline: result.receipt } : {}) };
      return result.moves;
    } };
}
