// Isolated candidate only. Cooperative deadlines are not equivalent pruning.
import { saveState, restoreState } from "./AIEngine.js?v=20261025-ai1";
import { isolatedSearchEngine, visitPolicyCandidates } from "./MultiplayerSearch.js?v=20261025-ai1";
import { ThreePlayerSearchAI, positionUtilityV4 } from "./ThreePlayerSearchAI.js?v=20261025-ai1";

const EXPIRED = Symbol("isolated Hard v2 shared deadline");
const pointOrder = (a, b) => a.point[1] - b.point[1] || a.point[0] - b.point[0];
const finishLinear = candidates => {
  const ranked = [...candidates].sort((a, b) => b.score - a.score || pointOrder(a, b));
  const maximum = ranked[0]?.score ?? 0;
  const total = ranked.reduce((sum, move) => sum + Math.exp(move.score - maximum), 0);
  return ranked.map(move => ({ ...move, prior: Math.exp(move.score - maximum) / total }));
};
function linearRanking(engine, player, spec, check, completed = []) {
  visitPolicyCandidates(engine, player, candidate => {
    const score = candidate.features.reduce((sum, value, i) => sum + value * spec.weights[i], 0) / (spec.temperature ?? 1);
    if (!Number.isFinite(score)) throw new Error("Invalid isolated Hard linear score");
    check(); completed.push({ point: candidate.point, score, visits: 1 });
  }, { beforeCandidate: check });
  check(); return finishLinear(completed);
}
function rankEvaluated(evaluated, baseline, minimumImprovement) {
  const ranked = [...evaluated].sort((a, b) => b.score - a.score || b.margin - a.margin
    || b.baseScore - a.baseScore || pointOrder(a, b));
  const baseMove = ranked.find(move => move.point.toString() === baseline.point.toString());
  if (!baseMove) throw new Error("Isolated v4 publication lacks a complete baseline");
  if (ranked[0].score - baseMove.score < minimumImprovement) {
    ranked.splice(ranked.indexOf(baseMove), 1); ranked.unshift(baseMove);
  }
  const values = ranked.map(move => Math.exp(4 * move.score));
  const total = values.reduce((a, b) => a + b, 0);
  return ranked.map((move, i) => ({ ...move, prior: values[i] / total }));
}
function validateMoves(source, player, moves) {
  const native = isolatedSearchEngine(source);
  for (const move of moves) {
    if (move.point === null) {
      // Replaying a PASS invokes the real rule. This is a deadline fallback,
      // never a claim that the player has no legal placements.
      const passEngine = isolatedSearchEngine(source);
      if (!passEngine.skipTurn().success) throw new Error("Invalid isolated Hard deadline PASS");
    } else if (!native._evaluateMove(move.point, player).legal) {
      throw new Error("Invalid isolated Hard fallback placement");
    }
  }
}

// Both linear and v4 use one private engine and the caller's absolute deadline.
// Linear partials and deadline-PASS are explicitly different fallback policies.
export class HardDeadlineFallbackV2 {
  constructor(spec, { searchV4 = false } = {}) {
    if (!Array.isArray(spec?.weights) || spec.weights.length !== 16 || !spec.weights.every(Number.isFinite)
      || !(Number.isFinite(spec.temperature ?? 1) && (spec.temperature ?? 1) > 0))
      throw new Error("Invalid isolated Hard fallback policy");
    if (searchV4) new ThreePlayerSearchAI(spec); // Reuse the frozen v4 schema validation.
    this.spec = structuredClone(spec); this.searchV4 = searchV4; this.lastSearch = null; this.fullRanking = null;
  }
  getTopMoves(source, player = source.currentPlayer, topN = 5, { deadline = Infinity, now = () => performance.now() } = {}) {
    this.lastSearch = null; this.fullRanking = null;
    if (!["territory-v2", "territory-v3"].includes(source.rulesVersion) || player !== source.currentPlayer
      || ![3,4,5,6].includes(source.playerCount) || this.searchV4 && source.playerCount !== 3
      || Number.isNaN(deadline)) throw new Error("Invalid isolated Hard fallback state/budget");
    const started = now();
    const stats = this.lastSearch = { algorithm: this.searchV4 ? "interruptible-original-v4" : "interruptible-original-linear",
      elapsedMs: 0, absoluteDeadline: deadline, baselineComplete: false, completed: false,
      partial: false, fallbackChanged: false, timedOut: false, decisionSource: null,
      simulatedActions: 0, simulations: 0, terminalLeaves: 0, canonicalScoreCalls: 0,
      canonicalScoringInterrupted: false, terminalScoringInterrupted: false,
      partialRootDiscarded: false, evaluated: [], baselineCandidatesCompleted: 0 };
    if (source.gameOver || topN <= 0) { stats.completed = true; return []; }
    const engine = isolatedSearchEngine(source), snapshot = saveState(engine);
    const check = () => { if (now() >= deadline) throw EXPIRED; };
    const originalEvaluate = engine._evaluateMove, evaluateDescriptor = Object.getOwnPropertyDescriptor(engine, "_evaluateMove");
    engine._evaluateMove = function(...args) { check(); const result = originalEvaluate.apply(this, args); check(); return result; };
    const baselineCandidates = []; let baseline = [], result = [], evaluatingRoot = false;
    const scoreLeaf = () => {
      const index = engine._keyToIdx, originalGet = index.get, descriptor = Object.getOwnPropertyDescriptor(index, "get");
      let probes = 0;
      index.get = function(key) { if ((++probes & 63) === 0) check(); return originalGet.call(this, key); };
      try {
        check(); stats.canonicalScoreCalls++;
        const leaf = positionUtilityV4(engine, player, this.spec.search);
        check(); return leaf;
      } catch (error) {
        if (error === EXPIRED) { stats.canonicalScoringInterrupted = true; stats.terminalScoringInterrupted = engine.gameOver; }
        throw error;
      } finally {
        if (descriptor) Object.defineProperty(index, "get", descriptor); else delete index.get;
      }
    };
    try {
      check(); baseline = linearRanking(engine, player, this.spec, check, baselineCandidates);
      stats.baselineComplete = true; this.fullRanking = structuredClone(baseline);
      result = this.searchV4 ? baseline.slice(0, this.spec.search.rootWidth) : baseline;
      stats.decisionSource = "original-linear";
      if (!this.searchV4 || result.length <= 1) {
        stats.completed = true; stats.forcedMove = this.searchV4 && result.length === 1;
      } else {
        const roots = baseline.slice(0, this.spec.search.rootWidth), evaluated = [];
        for (const move of roots) {
          evaluatingRoot = true; const leaves = [];
          for (const opponent of this.spec.search.opponents) {
            check(); restoreState(engine, snapshot);
            if (!engine.playMove(move.point).success) throw new Error("Invalid isolated v4 root action");
            check(); stats.simulatedActions++;
            for (let ply = 0; ply < this.spec.search.rolloutPlies && !engine.gameOver; ply++) {
              check(); const spec = engine.currentPlayer === player ? this.spec : opponent;
              const reply = linearRanking(engine, engine.currentPlayer, spec, check)[0]?.point ?? null;
              if (!(reply ? engine.playMove(reply) : engine.skipTurn()).success) throw new Error("Invalid isolated v4 rollout action");
              check(); stats.simulatedActions++;
            }
            const leaf = scoreLeaf(); leaves.push(leaf); stats.simulations++; stats.terminalLeaves += Number(leaf.terminal);
          }
          check(); evaluated.push({ point: [...move.point], baseScore: move.score,
            score: leaves.reduce((sum, leaf) => sum + leaf.value, 0) / leaves.length,
            margin: leaves.reduce((sum, leaf) => sum + leaf.margin, 0) / leaves.length,
            leaves, visits: leaves.length });
          evaluatingRoot = false;
          // ranked[0] is evaluated first, and every published root has ALL
          // original opponent responses. No partial-response average escapes.
          result = rankEvaluated(evaluated, baseline[0], this.spec.search.minimumImprovement);
          stats.evaluated = structuredClone(result.map(({ prior, ...move }) => move));
          stats.decisionSource = "completed-v4-comparisons";
        }
        stats.completed = true; stats.decisionSource = "original-v4-complete";
      }
    } catch (error) {
      if (error !== EXPIRED) throw error;
      stats.timedOut = true; stats.partial = true; stats.fallbackChanged = true;
      stats.partialRootDiscarded = evaluatingRoot;
      if (!stats.baselineComplete) {
        result = finishLinear(baselineCandidates);
        stats.decisionSource = result.length ? "partial-linear" : "deadline-pass";
      }
    } finally {
      if (evaluateDescriptor) Object.defineProperty(engine, "_evaluateMove", evaluateDescriptor); else delete engine._evaluateMove;
      restoreState(engine, snapshot);
      stats.baselineCandidatesCompleted = baselineCandidates.length;
      stats.elapsedMs = now() - started;
    }
    if (!result.length) {
      result = [{ type: "pass", point: null, score: 0, visits: 1 }];
      if (stats.baselineComplete) stats.decisionSource = "no-legal-placement";
    }
    const moves = result.slice(0, Math.max(0, Math.floor(topN)));
    validateMoves(source, player, moves);
    stats.elapsedMs = now() - started;
    return moves;
  }
}
