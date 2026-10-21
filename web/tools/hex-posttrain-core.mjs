import { GameEngine, PLAYER_ORDER } from "../web前端/GameEngine.js";
import { saveState, restoreState, fastTerritoryBFS } from "../web前端/AIEngine.js";
import { HEX_PLAYER_FEATURES, hexPlayerCandidates } from "../web前端/HexPlayerAI.js";

export { HEX_PLAYER_FEATURES };
export const playersFor = (count) => PLAYER_ORDER.slice(0, count);
export function rng(seed) {
  return { state: seed >>> 0, next() { this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0; return this.state / 4294967296; } };
}
export function engineFor(spec, actions = []) {
  const engine = new GameEngine({ gridSize: spec.size, playerCount: spec.players,
    rulesVersion: "territory-v2", startPlayer: spec.start });
  engine._isReplayingBatch = true;
  for (const action of actions) apply(engine, action);
  return engine;
}
export function apply(engine, action) {
  if (engine.gameOver || action.actor !== engine.currentPlayer) throw new Error("Saved action actor/terminal mismatch.");
  if (action.point === null) {
    if (engine.getLegalMoves().length) throw new Error("Saved forced pass has legal moves.");
    if (!engine.skipTurn().success) throw new Error("Saved pass rejected.");
  } else if (!engine.playMove(action.point).success) throw new Error("Saved move is illegal.");
}
export function policy(engine, weights, candidates = hexPlayerCandidates(engine)) {
  return candidates.map((c) => ({ ...c, score: c.features.reduce((sum, x, i) => sum + x * weights[i], 0) }))
    .sort((a, b) => b.score - a.score || a.point[1] - b.point[1] || a.point[0] - b.point[0]);
}
export function outcome(engine) {
  if (!engine.gameOver) throw new Error("No outcome for a truncated game.");
  engine.getWinner();
  const areas = Object.fromEntries(engine.activePlayers.map((p) => [p, engine.cachedTerritories[p].area]));
  const maximum = Math.max(...Object.values(areas)), winners = engine.activePlayers.filter((p) => areas[p] === maximum);
  return { areas, winners, shares: Object.fromEntries(engine.activePlayers.map((p) => [p, winners.includes(p) ? 1 / winners.length : 0])) };
}
export function utility(engine, actor) {
  if (engine.gameOver) {
    const result = outcome(engine);
    return 10000 * (result.shares[actor] - 1 / engine.playerCount);
  }
  engine._updateTerritories();
  const own = (p) => 25 * engine._getPlayerNodes(p).length + 8 * engine._getPlayerLines(p).length
    + 20 * fastTerritoryBFS(engine, p) + 100 * engine.cachedTerritories[p].area;
  return own(actor) - Math.max(...engine.activePlayers.filter((p) => p !== actor).map(own));
}
export function roundTeacher(engine, weights, { shortlist = 3 } = {}) {
  const candidates = hexPlayerCandidates(engine), base = saveState(engine), flag = engine._isReplayingBatch;
  const actor = engine.currentPlayer;
  const parentOrder = policy(engine, weights, candidates);
  const heuristicOrder = [...candidates].sort((a, b) => {
    const score = (c) => 25 * c.features[3] + 8 * c.features[4] + 20 * c.features[5] + 10 * c.features[6];
    return score(b) - score(a) || a.point[1] - b.point[1] || a.point[0] - b.point[0];
  });
  const selected = [];
  for (const candidate of [parentOrder[0], heuristicOrder[0], ...parentOrder.slice(1), ...heuristicOrder.slice(1)]) {
    if (candidate && !selected.some((c) => c.point[0] === candidate.point[0] && c.point[1] === candidate.point[1])) selected.push(candidate);
    if (selected.length >= shortlist) break;
  }
  engine._isReplayingBatch = true;
  try {
    const targets = [];
    for (const candidate of selected) {
      restoreState(engine, base);
      if (!engine.playMove(candidate.point).success) throw new Error("Teacher root action rejected.");
      // Follow the real acting player through up to one full opponent round.
      // Forced automatic passes may return to the root earlier.
      for (let step = 0; step < engine.playerCount - 1 && !engine.gameOver && engine.currentPlayer !== actor; step += 1) {
        const reply = policy(engine, weights)[0]?.point ?? null;
        apply(engine, { actor: engine.currentPlayer, point: reply });
      }
      targets.push({ ...candidate, score: utility(engine, actor) });
    }
    return { candidates, targets: targets.sort((a, b) => b.score - a.score || a.point[1] - b.point[1] || a.point[0] - b.point[0]) };
  } finally { restoreState(engine, base); engine._isReplayingBatch = flag; }
}
export function softmax(scores, temperature = 1) {
  const max = Math.max(...scores), values = scores.map((x) => Math.exp((x - max) / temperature));
  const total = values.reduce((a, b) => a + b, 0);
  return values.map((x) => x / total);
}
export function loss(samples, weights) {
  return samples.reduce((sum, sample) => {
    const probs = softmax(sample.features.map((features) => features.reduce((value, x, i) => value + x * weights[i], 0)));
    return sum - sample.targets.reduce((value, y, i) => value + y * Math.log(Math.max(1e-12, probs[i])), 0);
  }, 0) / samples.length;
}
export function adam(samples, state, options, parent) {
  const gradient = Array(16).fill(0);
  for (const sample of samples) {
    const probs = softmax(sample.features.map((features) => features.reduce((sum, x, i) => sum + x * state.weights[i], 0)));
    sample.features.forEach((features, j) => features.forEach((x, i) => { gradient[i] += (probs[j] - sample.targets[j]) * x / samples.length; }));
  }
  state.epoch += 1;
  state.weights = state.weights.map((weight, i) => {
    const g = gradient[i] + options.anchor * (weight - parent[i]);
    state.m[i] = 0.9 * state.m[i] + 0.1 * g;
    state.v[i] = 0.999 * state.v[i] + 0.001 * g * g;
    return weight - options.learningRate * (state.m[i] / (1 - 0.9 ** state.epoch))
      / (Math.sqrt(state.v[i] / (1 - 0.999 ** state.epoch)) + 1e-8);
  });
  if (!state.weights.every(Number.isFinite)) throw new Error("Non-finite optimizer state.");
}
