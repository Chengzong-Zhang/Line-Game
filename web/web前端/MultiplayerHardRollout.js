// NEW ALGORITHM: heuristic-v2 nonterminal values; exact native natural terminals. Not production.
import { evaluateNonterminalTeacher } from "./MultiplayerHardValue.js?v=20261026-start-protection-v1";
// Experimental policy improvement: selfish opponent rollouts and canonical area.
// Candidate ordering never removes legal roots. Hard publishes complete sweeps;
// the opt-in mode can publish fully evaluated improvements within a sweep.
import { GameEngine } from "./GameEngine.js?v=20261026-start-protection-v1";
import { saveState, restoreState } from "./AIEngine.js?v=20261026-start-protection-v1";
import { isolatedSearchEngine, multiplayerMetrics, visitPolicyCandidates } from "./MultiplayerSearch.js?v=20261026-start-protection-v1";

const DEADLINE = Symbol("multiplayer rollout budget");
const key = point => point === null ? "PASS" : point.join(",");
const order = (a, b) => a.point === null ? (b.point === null ? 0 : 1)
  : b.point === null ? -1 : a.point[1] - b.point[1] || a.point[0] - b.point[0];
function scorer(policy) {
  if (typeof policy?.score === "function") return values => policy.score(values);
  if (!Array.isArray(policy?.weights) || policy.weights.length !== 16 || !policy.weights.every(Number.isFinite)
    || !Number.isFinite(policy.temperature ?? 1) || (policy.temperature ?? 1) <= 0) throw new Error("Invalid rollout linear policy");
  return values => values.reduce((sum, value, i) => sum + value * policy.weights[i], 0) / (policy.temperature ?? 1);
}
function branch(engine) {
  const saved = { grid: engine.grid, edges: engine.edges, historySize: engine.historyHashes.size,
    currentPlayer: engine.currentPlayer, gameOver: engine.gameOver, turnCount: engine.turnCount,
    consecutiveSkips: engine.consecutiveSkips, positionRevision: engine.positionRevision,
    territoryStateRevision: engine._territoryStateRevision };
  engine.grid = new Map(engine.grid);
  engine.edges = Object.fromEntries(engine.activePlayers.map(p => [p, new Set(engine.edges[p])]));
  return saved;
}
function rollback(engine, saved) {
  const appended = [...engine.historyHashes].slice(saved.historySize);
  for (const hash of appended) engine.historyHashes.delete(hash);
  Object.assign(engine, { grid: saved.grid, edges: saved.edges, currentPlayer: saved.currentPlayer,
    gameOver: saved.gameOver, turnCount: saved.turnCount, consecutiveSkips: saved.consecutiveSkips,
    positionRevision: saved.positionRevision, _territoryStateRevision: saved.territoryStateRevision });
}

export class MultiplayerRolloutAI {
  constructor({ basePolicy, responsePolicies = [basePolicy], fallbackPolicy = null, fallbackMove = null,
    rootPriors = null, timeMs = 650, rolloutPlies = 12, minimumImprovement = 0.02,
    coverageWeight = 0.3, reachWeight = 0.05, valueTemperature = 0.12,
    nodeBudget = Infinity, allowPass = true, reuseRootRanking = true,
    publishCompletedComparisons = false, traceComparisons = false, fallbackKind = null } = {}) {
    this.base = scorer(basePolicy);
    if (!responsePolicies.length) throw new Error("At least one opponent policy is required");
    this.responses = responsePolicies.map(scorer);
    this.horizons = Array.isArray(rolloutPlies) ? [...rolloutPlies] : [rolloutPlies];
    if (!this.horizons.length || this.horizons.some(n => !Number.isInteger(n) || n < 0 || n > 48)
      || !(timeMs > 0) || !(nodeBudget > 0) || !Number.isFinite(minimumImprovement)
      || minimumImprovement < 0 || minimumImprovement > 1
      || ![coverageWeight, reachWeight, valueTemperature].every(Number.isFinite)
      || coverageWeight < 0 || reachWeight < 0 || valueTemperature <= 0) throw new Error("Invalid rollout budget or value settings");
    Object.assign(this, { basePolicy, fallbackPolicy, fallbackMove, rootPriors, timeMs, minimumImprovement,
      coverageWeight, reachWeight, valueTemperature, nodeBudget, allowPass, reuseRootRanking,
      publishCompletedComparisons, traceComparisons, fallbackKind });
    this.lastSearch = null;
  }

  getTopMoves(source, player = source.currentPlayer, topN = 5) {
    if (!["territory-v2", "territory-v3"].includes(source.rulesVersion) || source.currentPlayer !== player)
      throw new Error("Invalid multiplayer rollout state");
    const started = performance.now(), deadline = this.absoluteDeadline ?? (started + this.timeMs);
    const stats = this.lastSearch = { algorithm: "selfish-policy-rollout-heuristic-v2-natural-terminal-area", elapsedMs: 0,
      fallbackMs: 0, policyCandidates: 0, simulatedActions: 0, terminalLeaves: 0, evaluatedLeaves: 0,
      canonicalScoreCalls: 0, canonicalCacheHits: 0,
      heuristicLeaves: 0, nonterminalEvaluation: "multiplayer-heuristic-value-v2", terminalEvaluation: `native-${source.rulesVersion}`,
      heuristicSourceSha256: "53f1f6f6d515538d73e31393e814b7b2e02c0fde8093d30142c1aaa1222247fb",
      heuristicWeights: { nodes: 15 / 43, coverage: 8 / 43, reach: 20 / 43, temperature: 0.12 }, completedPhases: [], legalRoots: 0,
      candidateCap: null, partialPhaseDiscarded: false, timedOut: false, usedFallback: true,
      fallbackBudgetExceeded: false, terminalScoringInterrupted: false, canonicalScoringInterrupted: false,
      reusedLinearRootRanking: false, rootPreparationMs: null,
      publicationMode: this.publishCompletedComparisons ? "completed-comparisons" : "complete-phase",
      fallbackKind: this.fallbackKind ?? (this.fallbackMove ? "supplied-move" : this.fallbackPolicy ? "base-policy" : "enumerated-linear"),
      decisionSource: "fallback", selectedEvaluation: "fallback-only", anytimePhases: [],
      completedRootComparisons: 0, acceptedPartialImprovements: 0,
      partialRootDiscarded: false, partialPhasePublished: false };
    if (source.gameOver || topN <= 0) return [];
    const engine = isolatedSearchEngine(source), root = saveState(engine);
    const check = () => {
      if (performance.now() >= deadline || stats.policyCandidates + stats.simulatedActions >= this.nodeBudget) throw DEADLINE;
    };
    const apply = point => point === null ? engine.skipTurn() : engine.playMove(point);
    const prior = point => this.rootPriors?.get(key(point)) ?? 0;
    const policyActions = (score, ensureOne = false) => {
      const actor = engine.currentPlayer, candidates = [];
      visitPolicyCandidates(engine, actor, candidate => {
        const value = score(candidate.features), point = candidate.point;
        if (!Number.isFinite(value)) throw new Error("Nonfinite rollout policy score");
        candidates.push({ point, baseScore: value });
        if (ensureOne && (!fallback.length || value > fallback[0].score
          || (value === fallback[0].score && order({ point }, fallback[0]) < 0)))
          fallback = [{ type: "move", point: [...point], score: value, baseScore: value, visits: 1 }];
      }, { beforeCandidate: () => {
        if (!ensureOne || candidates.length) check();
        stats.policyCandidates++;
      } });
      return candidates.sort((a, b) => b.baseScore - a.baseScore || order(a, b));
    };
    const canonicalCache = new Map();
    const canonicalAreas = () => {
      // Canonical area depends on physical occupancy, geometry, rules and seats;
      // including the complete state hash is conservative and avoids aliasing.
      const identity = engine._computeStateHash(engine.currentPlayer);
      if (canonicalCache.has(identity)) { stats.canonicalCacheHits++; return canonicalCache.get(identity); }
      const index = engine._keyToIdx, originalGet = index.get;
      const descriptor = Object.getOwnPropertyDescriptor(index, "get");
      let probes = 0;
      index.get = function(k) { if ((++probes & 63) === 0) check(); return originalGet.call(this, k); };
      engine.cachedTerritories = { ...engine.cachedTerritories };
      try {
        check(); stats.canonicalScoreCalls++;
        GameEngine.prototype._updateTerritories.call(engine);
        check();
      } catch (error) {
        if (error === DEADLINE) {
          stats.canonicalScoringInterrupted = true;
          stats.terminalScoringInterrupted = engine.gameOver;
        }
        throw error;
      } finally {
        if (descriptor) Object.defineProperty(index, "get", descriptor); else delete index.get;
      }
      const areas = Object.fromEntries(engine.activePlayers.map(p => [p, engine.cachedTerritories[p].area]));
      canonicalCache.set(identity, areas);
      return areas;
    };
    const leaf = () => {
      const alive = engine.activePlayers.filter(p => !engine.resignedPlayers.has(p));
      if (!engine.gameOver) {
        check();
        const metrics = multiplayerMetrics(engine);
        check();
        const evaluated = evaluateNonterminalTeacher(metrics, player, alive, engine.validPositions.length, {
          nodeWeight: 15 / 43, coverageWeight: 8 / 43, reachWeight: 20 / 43, valueTemperature: 0.12,
        });
        check();
        stats.evaluatedLeaves++; stats.heuristicLeaves++;
        return { value: evaluated.heuristicValue, margin: evaluated.heuristicMargin, terminal: false };
      }
      const areas = canonicalAreas();
      const best = Math.max(...alive.map(p => areas[p])), winners = alive.filter(p => areas[p] === best);
      const margin = (areas[player] - Math.max(0, ...alive.filter(p => p !== player).map(p => areas[p]))) / engine.validPositions.length;
      stats.evaluatedLeaves++; stats.terminalLeaves++;
      return { value: winners.includes(player) ? 1 / winners.length : 0, margin, terminal: true };
    };
    let fallback = [], published = [], completeLinearRanking = null;
    try {
      if (this.fallbackMove) {
        const point = this.fallbackMove.point ?? null;
        if (!(point === null || engine._evaluateMove(point, player).legal)) throw new Error("Invalid supplied fallback move");
        fallback = [{ ...this.fallbackMove, point: point === null ? null : [...point] }];
      } else if (this.fallbackPolicy) {
        const fallbackStarted = performance.now();
        // Arbitrary injected synchronous policies are not preemptible. Their
        // measured cost is included; prefer a precomputed fallback if costly.
        const contract = this.fallbackPolicy.fullRankingContract;
        if (this.reuseRootRanking && contract?.kind === "multiplayer-linear-full-ranking" && contract.version === 1
          && contract.spec === this.basePolicy && typeof this.fallbackPolicy.getFullRanking === "function") {
          completeLinearRanking = this.fallbackPolicy.getFullRanking(isolatedSearchEngine(engine), player);
          fallback = completeLinearRanking.slice(0, Math.max(1, topN));
        } else fallback = this.fallbackPolicy.getTopMoves(isolatedSearchEngine(engine), player, Math.max(1, topN));
        stats.fallbackMs = performance.now() - fallbackStarted;
        stats.fallbackBudgetExceeded = performance.now() >= deadline;
        if (!fallback.length && !engine.getLegalMoves(player).length) fallback = [{ type: "pass", point: null, score: 0 }];
        // Check the complete cheap ranking contract even when the time budget
        // has elapsed. The native check below always covers every returnable
        // fallback; unreturned roots are checked only if search can continue.
        if (completeLinearRanking) {
          const seen = new Set();
          for (const move of completeLinearRanking) {
            if (move.point === null || !Number.isFinite(move.score) || seen.has(key(move.point)))
              throw new Error("Invalid complete linear ranking");
            seen.add(key(move.point));
          }
        }
        const validationNodes = engine._getPlayerNodes(player), validationHashOrder = engine._getStateHashOrder();
        for (const move of fallback) {
          if (!(move.point === null || engine._evaluateMove(move.point, player, validationNodes, validationHashOrder).legal))
            throw new Error("Illegal fallback policy action");
        }
        check();
        if (completeLinearRanking) {
          for (let index = fallback.length; index < completeLinearRanking.length; index++) {
            check();
            if (!engine._evaluateMove(completeLinearRanking[index].point, player, validationNodes, validationHashOrder).legal)
              throw new Error("Illegal fallback policy action");
          }
        }
        check();
      }
      const roots = completeLinearRanking
        ? completeLinearRanking.map(move => ({ point: [...move.point], baseScore: move.score }))
        : policyActions(this.base, !fallback.length);
      stats.reusedLinearRootRanking = completeLinearRanking !== null;
      if (!fallback.length) fallback = roots.map(move => ({ ...move, score: move.baseScore, type: "move", visits: 1 }));
      if (this.allowPass || !roots.length) roots.push({ point: null, baseScore: -Infinity });
      if (!fallback.length) fallback = [{ type: "pass", point: null, score: 0, visits: 1 }];
      stats.legalRoots = roots.length;
      roots.sort((a, b) => prior(b.point) - prior(a.point) || b.baseScore - a.baseScore || order(a, b));
      stats.rootPreparationMs = performance.now() - started;
      const fallbackKey = key(fallback[0].point);
      // Both publication modes share the same canonical continuation/scorer.
      // The default path preserves its original checks and complete-sweep order.
      const evaluateResponse = (move, plies, responseIndex) => {
        check(); restoreState(engine, root);
        if (!apply(move.point).success) throw new Error("Legal rollout root changed");
        const rootTerminal = engine.gameOver;
        stats.simulatedActions++;
        for (let ply = 0; ply < plies && !engine.gameOver; ply++) {
          check();
          const policy = engine.currentPlayer === player ? this.base : this.responses[responseIndex];
          const action = policyActions(policy)[0]?.point ?? null;
          if (!apply(action).success) throw new Error("Illegal rollout continuation");
          stats.simulatedActions++;
        }
        const result = leaf();
        if (this.publishCompletedComparisons) check();
        // Only the completed native terminal score can prove that this root
        // action already won. A later rollout win or a near-one heuristic cannot.
        if (source.rulesVersion === "territory-v3" && rootTerminal && result.terminal
          && result.value === 1 && result.margin > 0 && engine._getRemainingPlayers().length >= 2)
          return { ...result, immediateTerminalWin: true };
        return result;
      };
      const scoredMove = (move, total, count) => ({ type: move.point === null ? "pass" : "move", point: move.point,
        score: total.value / count, margin: total.margin / count,
        baseScore: move.baseScore, prior: prior(move.point), visits: count,
        ...(total.immediateTerminalWins === count ? { immediateTerminalWin: true } : {}) });
      const rank = (moves, incumbentKey) => {
        const ranked = [...moves].sort((a, b) => Number(b.immediateTerminalWin === true) - Number(a.immediateTerminalWin === true)
          || b.score - a.score || b.margin - a.margin
          || b.prior - a.prior || b.baseScore - a.baseScore || order(a, b));
        const incumbent = ranked.find(move => key(move.point) === incumbentKey);
        if (incumbent && !(ranked[0].immediateTerminalWin === true && incumbent.immediateTerminalWin !== true)
          && ranked[0].score - incumbent.score < this.minimumImprovement) {
          ranked.splice(ranked.indexOf(incumbent), 1); ranked.unshift(incumbent);
        }
        return { ranked, incumbent };
      };
      const recordPhase = (plies, count, incumbent) => {
        stats.usedFallback = key(published[0].point) === fallbackKey;
        stats.completedPhases.push({ rolloutPlies: plies, responsePolicies: count, roots: roots.length,
          selectedPoint: published[0].point, score: published[0].score,
          incumbentPoint: incumbent?.point ?? null, incumbentScore: incumbent?.score ?? null,
          fallbackScore: published.find(move => key(move.point) === fallbackKey)?.score ?? null });
      };
      for (const plies of this.horizons) {
        if (!this.publishCompletedComparisons) {
          const totals = new Map(roots.map(move => [key(move.point), { value: 0, margin: 0 }]));
          for (let responseIndex = 0; responseIndex < this.responses.length; responseIndex++) {
            const values = [];
            for (const move of roots) values.push({ ...move, ...evaluateResponse(move, plies, responseIndex) });
            // Hard keeps the old atomic complete-root sweep publication.
            for (const value of values) {
              const total = totals.get(key(value.point)); total.value += value.value; total.margin += value.margin;
              if (value.immediateTerminalWin) total.immediateTerminalWins = (total.immediateTerminalWins ?? 0) + 1;
            }
            const count = responseIndex + 1;
            const incumbentKey = published.length ? key(published[0].point) : fallbackKey;
            const result = rank(roots.map(move => scoredMove(move, totals.get(key(move.point)), count)), incumbentKey);
            published = result.ranked;
            recordPhase(plies, count, result.incumbent);
          }
          continue;
        }
        // Cache complete responses only within one horizon. Each comparison
        // contains the complete response prefix; a partial leaf is never added.
        const results = new Map(roots.map(move => [key(move.point), []]));
        for (let responseIndex = 0; responseIndex < this.responses.length; responseIndex++) {
          const count = responseIndex + 1;
          const entryKey = published.length ? key(published[0].point) : fallbackKey;
          const entryRoot = roots.find(move => key(move.point) === entryKey);
          if (!entryRoot) throw new Error("Phase incumbent missing from legal roots");
          const phase = { rolloutPlies: plies, responsePolicies: count,
            roots: roots.length, evaluatedRoots: 0, completed: false,
            entryIncumbentPoint: entryRoot.point, entryIncumbentScore: null,
            selectedPoint: entryRoot.point, selectedScore: null, acceptedImprovements: 0 };
          if (this.traceComparisons) phase.comparisons = [];
          stats.anytimePhases.push(phase);
          const evaluate = move => {
            const cached = results.get(key(move.point));
            for (let variant = cached.length; variant < count; variant++)
              cached.push(evaluateResponse(move, plies, variant));
            const total = { value: 0, margin: 0 };
            for (let variant = 0; variant < count; variant++) {
              total.value += cached[variant].value; total.margin += cached[variant].margin;
              if (cached[variant].immediateTerminalWin) total.immediateTerminalWins = (total.immediateTerminalWins ?? 0) + 1;
            }
            check();
            return scoredMove(move, total, count);
          };
          const entry = evaluate(entryRoot), evaluated = [entry];
          phase.entryIncumbentScore = entry.score; phase.evaluatedRoots = 1;
          // Fix the entry anchor for the entire phase, matching complete-sweep
          // selection. Later +.01 gains can extend an earlier +.03 improvement.
          published = rank(evaluated, entryKey).ranked;
          phase.selectedScore = entry.score;
          for (const move of roots) {
            if (key(move.point) === entryKey) continue;
            const candidate = evaluate(move);
            evaluated.push(candidate); phase.evaluatedRoots++; stats.completedRootComparisons++;
            const ranked = rank(evaluated, entryKey).ranked;
            const changed = key(ranked[0].point) !== key(published[0].point);
            if (this.traceComparisons) phase.comparisons.push({ point: candidate.point,
              score: candidate.score, margin: candidate.margin, prior: candidate.prior, baseScore: candidate.baseScore,
              entryScore: entry.score, selectedPoint: ranked[0].point, selectedScore: ranked[0].score, changed });
            if (changed) { phase.acceptedImprovements++; stats.acceptedPartialImprovements++; }
            published = ranked; phase.selectedPoint = ranked[0].point; phase.selectedScore = ranked[0].score;
            stats.usedFallback = key(ranked[0].point) === fallbackKey;
          }
          phase.completed = true;
          recordPhase(plies, count, entry);
        }
      }
    } catch (error) {
      if (error !== DEADLINE) throw error;
      stats.timedOut = true; stats.partialPhaseDiscarded = true;
      if (this.publishCompletedComparisons) {
        stats.partialRootDiscarded = true;
        const phase = stats.anytimePhases.at(-1);
        stats.partialPhasePublished = Boolean(phase && !phase.completed && phase.acceptedImprovements > 0);
        stats.partialPhaseDiscarded = !stats.partialPhasePublished;
      }
    } finally { stats.elapsedMs = performance.now() - started; }
    stats.decisionSource = stats.usedFallback ? "fallback" : this.publishCompletedComparisons ? "completed-comparison" : "complete-phase";
    stats.selectedEvaluation = published.length
      ? this.publishCompletedComparisons ? "complete-response-prefix" : "complete-root-phase"
      : "fallback-only";
    return (published.length ? published : fallback).slice(0, topN);
  }
}
