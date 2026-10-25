// Local v4 candidate. No runtime registration: promotion is a separate gate.
import { fastTerritoryBFS, restoreState, saveState } from "./AIEngine.js?v=20261025-unified1";
import { ThreePlayerAI, THREE_PLAYER_FEATURES } from "./ThreePlayerAI.js?v=20261025-unified1";
import { GameEngine } from "./GameEngine.js?v=20261025-unified1";

const pointOrder = (a, b) => a.point[1] - b.point[1] || a.point[0] - b.point[0];
const linear = (spec) => ({ score: (values) => values.reduce((sum, value, i) => sum + value * spec.weights[i], 0) / spec.temperature });
function validWeights(spec) {
  return Array.isArray(spec.weights) && spec.weights.length === THREE_PLAYER_FEATURES.length
    && spec.weights.every(Number.isFinite) && Number.isFinite(spec.temperature) && spec.temperature > 0;
}

export function positionUtilityV4(engine, player, spec) {
  // restoreState assigns its cache object by reference. Detach before refreshing
  // so a speculative terminal/leaf evaluation cannot mutate an ancestor cache.
  engine.cachedTerritories = { ...engine.cachedTerritories };
  // Existing AI workers suppress the instance updater while searching. Scoring
  // must still execute the canonical rule implementation, never that no-op.
  GameEngine.prototype._updateTerritories.call(engine);
  const players = engine.activePlayers.filter((p) => !engine.resignedPlayers.has(p));
  const areas = Object.fromEntries(players.map((p) => [p, engine.cachedTerritories[p].area]));
  const bestArea = Math.max(...players.map((p) => areas[p]));
  const leaders = players.filter((p) => areas[p] === bestArea);
  const count = engine.validPositions.length;
  const margin = (areas[player] - Math.max(...players.filter((p) => p !== player).map((p) => areas[p]))) / count;
  if (engine.gameOver) return { value: leaders.includes(player) ? 1 / leaders.length : 0, margin, terminal: true, areas };
  const strengths = players.map((p) => areas[p]
    + spec.coverageWeight * (engine._getPlayerNodes(p).length + engine._getPlayerLines(p).length)
    + spec.reachWeight * fastTerritoryBFS(engine, p));
  const maximum = Math.max(...strengths);
  const exp = strengths.map((value) => Math.exp((value - maximum) / (count * spec.valueTemperature)));
  return { value: exp[players.indexOf(player)] / exp.reduce((a, b) => a + b, 0), margin, terminal: false, areas };
}

export class ThreePlayerSearchAI {
  constructor(payload) {
    const s = payload.search;
    if (payload.schema?.name !== "lifeline-three-player-search" || payload.schema.version !== 4
      || payload.rules_version !== "territory-v2" || !validWeights(payload)
      || JSON.stringify(payload.features) !== JSON.stringify(THREE_PLAYER_FEATURES)
      || !s || !Number.isInteger(s.rootWidth) || s.rootWidth < 1 || s.rootWidth > 8
      || !Number.isInteger(s.rolloutPlies) || s.rolloutPlies < 1 || s.rolloutPlies > 48
      || !Array.isArray(s.opponents) || !s.opponents.length || s.opponents.length > 2
      || !s.opponents.every(validWeights)
      || ![s.coverageWeight, s.reachWeight, s.valueTemperature, s.minimumImprovement].every(Number.isFinite)
      || s.coverageWeight < 0 || s.reachWeight < 0 || s.valueTemperature <= 0
      || s.minimumImprovement < 0 || s.minimumImprovement > 1) throw new Error("INVALID v4 search policy");
    this.spec = structuredClone(payload);
    this.base = new ThreePlayerAI(linear(payload));
    this.responses = s.opponents.map((opponent) => new ThreePlayerAI(linear(opponent)));
    this.lastSearch = null;
  }

  getTopMoves(engine, player = engine.currentPlayer, topN = 5) {
    this.lastSearch = { simulations: 0, simulatedActions: 0, terminalLeaves: 0, elapsedMs: 0, evaluated: [] };
    if (engine.playerCount !== 3 || !["territory-v2", "territory-v3"].includes(engine.rulesVersion) || engine.currentPlayer !== player
      || engine.gridSize < 5 || engine.gridSize > 15) throw new Error("INVALID v4 game contract");
    if (engine.gameOver) return [];
    const snapshot = saveState(engine), flag = engine._isReplayingBatch;
    engine._isReplayingBatch = true;
    const started = Date.now(), stats = { simulations: 0, simulatedActions: 0, terminalLeaves: 0 };
    try {
      const ranked = this.base.getTopMoves(engine, player, this.spec.search.rootWidth);
      if (!ranked.length) return [];
      if (ranked.length === 1) {
        this.lastSearch = { ...stats, elapsedMs: Date.now() - started, evaluated: [], forcedMove: true };
        return ranked.slice(0, Math.max(0, Math.floor(topN)));
      }
      const evaluated = [];
      for (const move of ranked) {
        const leaves = [];
        for (const opponent of this.responses) {
          restoreState(engine, snapshot);
          if (!engine.playMove(move.point).success) throw new Error("INVALID v4 root action");
          stats.simulatedActions++;
          for (let ply = 0; ply < this.spec.search.rolloutPlies && !engine.gameOver; ply++) {
            const policy = engine.currentPlayer === player ? this.base : opponent;
            const reply = policy.getTopMoves(engine, engine.currentPlayer, 1)[0]?.point ?? null;
            const result = reply ? engine.playMove(reply) : engine.skipTurn();
            if (!result.success) throw new Error("INVALID v4 rollout action");
            stats.simulatedActions++;
          }
          const leaf = positionUtilityV4(engine, player, this.spec.search);
          leaves.push(leaf); stats.simulations++; stats.terminalLeaves += Number(leaf.terminal);
        }
        evaluated.push({ point: [...move.point], baseScore: move.score,
          score: leaves.reduce((sum, leaf) => sum + leaf.value, 0) / leaves.length,
          margin: leaves.reduce((sum, leaf) => sum + leaf.margin, 0) / leaves.length,
          leaves, visits: leaves.length });
      }
      evaluated.sort((a, b) => b.score - a.score || b.margin - a.margin || b.baseScore - a.baseScore || pointOrder(a, b));
      const baseMove = evaluated.find((move) => move.point.toString() === ranked[0].point.toString());
      if (evaluated[0].score - baseMove.score < this.spec.search.minimumImprovement) {
        evaluated.splice(evaluated.indexOf(baseMove), 1); evaluated.unshift(baseMove);
      }
      const values = evaluated.map((move) => Math.exp(4 * move.score));
      const total = values.reduce((a, b) => a + b, 0);
      this.lastSearch = { ...stats, elapsedMs: Date.now() - started, evaluated: structuredClone(evaluated) };
      return evaluated.map((move, i) => ({ ...move, prior: values[i] / total })).slice(0, Math.max(0, Math.floor(topN)));
    } finally { restoreState(engine, snapshot); engine._isReplayingBatch = flag; }
  }
}
