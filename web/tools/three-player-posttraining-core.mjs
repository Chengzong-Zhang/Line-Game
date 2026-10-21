import { GameEngine } from "../web前端/GameEngine.js";
import { fastTerritoryBFS, saveState, restoreState } from "../web前端/AIEngine.js";
import { threePlayerCandidates } from "../web前端/ThreePlayerAI.js";

export const COLORS = Object.freeze(["BLACK", "WHITE", "PURPLE"]);
const pointOrder = (a, b) => a.point[1] - b.point[1] || a.point[0] - b.point[0];

export function softmax(values, temperature = 1) {
  const maximum = Math.max(...values);
  const exp = values.map((value) => Math.exp((value - maximum) / temperature));
  const total = exp.reduce((sum, value) => sum + value, 0);
  return exp.map((value) => value / total);
}

export function createRng(state) {
  return {
    state: state >>> 0,
    next() { this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0; return this.state / 4294967296; },
  };
}

export function policyMoves(engine, weights, candidates = threePlayerCandidates(engine)) {
  return candidates.map((candidate) => ({
    ...candidate, score: candidate.features.reduce((sum, x, i) => sum + x * weights[i], 0),
  })).sort((a, b) => b.score - a.score || pointOrder(a, b));
}

export function terminalOutcome(engine) {
  if (!engine.gameOver) throw new Error("Terminal outcome requested for a nonterminal game.");
  engine.getWinner(); // Refresh canonical discrete territory areas when needed.
  const scores = Object.fromEntries(COLORS.map((player) => [player, engine.cachedTerritories[player].area]));
  const survivors = COLORS.filter((player) => !engine.resignedPlayers.has(player));
  const maximum = Math.max(...survivors.map((player) => scores[player]));
  const leaders = survivors.filter((player) => scores[player] === maximum);
  return { scores, leaders, shares: Object.fromEntries(COLORS.map((player) => [player, leaders.includes(player) ? 1 / leaders.length : 0])) };
}

export function utilityVector(engine) {
  if (engine.gameOver) {
    const outcome = terminalOutcome(engine);
    return COLORS.map((player) => {
      const rivalArea = Math.max(...COLORS.filter((p) => p !== player).map((p) => outcome.scores[p]));
      // A finished win outranks every nonterminal heuristic; loss cannot be
      // confused with large fast-territory reach or with geometric displayArea.
      return 10000 * (outcome.shares[player] - 1 / COLORS.length)
        + (outcome.scores[player] - rivalArea) / engine.validPositions.length;
    });
  }
  const absolute = COLORS.map((player) => engine.resignedPlayers.has(player) ? -1000
    : 25 * engine._getPlayerNodes(player).length
      + 8 * engine._getPlayerLines(player).length
      + 20 * fastTerritoryBFS(engine, player));
  return absolute.map((value, i) => value - Math.max(...absolute.filter((_, j) => j !== i)));
}

function orderedChildren(engine, player, limit) {
  const snapshot = saveState(engine), children = [];
  try {
    for (const { point } of engine.getLegalMoves(player)) {
      restoreState(engine, snapshot);
      if (engine.playMove(point).success) children.push({ point: [...point], score: utilityVector(engine)[COLORS.indexOf(player)] });
    }
  } finally { restoreState(engine, snapshot); }
  children.sort((a, b) => b.score - a.score || pointOrder(a, b));
  return limit ? children.slice(0, limit) : children;
}

function maxN(engine, remaining, replyWidth, stats) {
  stats.nodes++;
  if (engine.gameOver || remaining === 0) return utilityVector(engine);
  const snapshot = saveState(engine);
  const actor = COLORS.indexOf(engine.currentPlayer);
  const children = orderedChildren(engine, engine.currentPlayer, replyWidth);
  try {
    if (!children.length) {
      engine.skipTurn();
      return maxN(engine, remaining - 1, replyWidth, stats);
    }
    let best = null;
    for (const child of children) {
      restoreState(engine, snapshot);
      if (!engine.playMove(child.point).success) throw new Error("MaxN produced an illegal child.");
      const vector = maxN(engine, remaining - 1, replyWidth, stats);
      // Propagate the entire selected vector. Automatic skip/resignation may
      // change whose turn follows; depth parity never determines the actor.
      if (!best || vector[actor] > best[actor]) best = vector;
    }
    return best;
  } finally { restoreState(engine, snapshot); }
}

export function maxNTeacher(engine, { depth = 3, replyWidth = 4 } = {}) {
  if (engine.playerCount !== 3 || engine.rulesVersion !== "territory-v2") throw new Error("Three-player territory-v2 required.");
  if (engine.gameOver) return { moves: [], nodes: 0 };
  const snapshot = saveState(engine), flag = engine._isReplayingBatch;
  const actor = COLORS.indexOf(engine.currentPlayer), stats = { nodes: 0 };
  engine._isReplayingBatch = true;
  try {
    // Every root legal action receives a teacher target. Only response levels
    // use the documented beam, avoiding an unlabelled-root-action blind spot.
    const moves = [];
    for (const { point } of engine.getLegalMoves(engine.currentPlayer)) {
      restoreState(engine, snapshot);
      if (!engine.playMove(point).success) throw new Error("MaxN root action became illegal.");
      const vector = maxN(engine, depth - 1, replyWidth, stats);
      moves.push({ point: [...point], score: vector[actor], vector });
    }
    return { moves: moves.sort((a, b) => b.score - a.score || pointOrder(a, b)), nodes: stats.nodes };
  } finally {
    restoreState(engine, snapshot);
    engine._isReplayingBatch = flag;
  }
}

export function engineFromActions(spec, actions = []) {
  const engine = new GameEngine({ gridSize: spec.size, playerCount: 3, startPlayer: spec.start,
    rulesVersion: "territory-v2" });
  engine._isReplayingBatch = true;
  for (const action of actions) {
    if (engine.gameOver || action.player !== engine.currentPlayer) throw new Error("Saved action prefix does not match the current rules.");
    if (action.point === null) {
      if (engine.getLegalMoves(engine.currentPlayer).length) throw new Error("Saved forced pass is invalid.");
      engine.skipTurn();
    } else if (!engine.playMove(action.point).success) throw new Error("Saved action prefix contains an illegal move.");
  }
  return engine;
}

export function crossEntropy(samples, weights) {
  if (!samples.length) throw new Error("Cannot evaluate an empty dataset.");
  return samples.reduce((total, sample) => {
    const probabilities = softmax(sample.features.map((x) => x.reduce((sum, value, i) => sum + value * weights[i], 0)));
    return total - sample.targets.reduce((sum, target, i) => sum + target * Math.log(Math.max(1e-12, probabilities[i])), 0);
  }, 0) / samples.length;
}

export function adamEpoch(samples, state, config, parentWeights) {
  const gradient = Array(state.weights.length).fill(0);
  for (const sample of samples) {
    const probabilities = softmax(sample.features.map((x) => x.reduce((sum, value, i) => sum + value * state.weights[i], 0)));
    sample.features.forEach((features, action) => features.forEach((value, i) => {
      gradient[i] += (probabilities[action] - sample.targets[action]) * value / samples.length;
    }));
  }
  state.epoch++;
  state.weights = state.weights.map((weight, i) => {
    const g = gradient[i] + config.anchorPenalty * (weight - parentWeights[i]);
    state.m[i] = config.beta1 * state.m[i] + (1 - config.beta1) * g;
    state.v[i] = config.beta2 * state.v[i] + (1 - config.beta2) * g * g;
    return weight - config.learningRate * (state.m[i] / (1 - config.beta1 ** state.epoch))
      / (Math.sqrt(state.v[i] / (1 - config.beta2 ** state.epoch)) + config.epsilon);
  });
  if (!state.weights.every(Number.isFinite)) throw new Error("Optimizer produced a nonfinite weight.");
}
