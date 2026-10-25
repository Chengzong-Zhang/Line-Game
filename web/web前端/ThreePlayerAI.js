import { fastTerritoryBFS, restoreState, saveState } from "./AIEngine.js?v=20261025-defense15";

export const THREE_PLAYER_MODEL_ID = "three-player-policy-v1";
export const THREE_PLAYER_FEATURES = Object.freeze([
  "own_nodes", "own_coverage", "own_reach", "node_lead", "coverage_lead",
  "reach_lead", "captured_nodes", "captured_coverage", "own_node_gain",
  "own_coverage_gain", "attack", "own_line", "distance_from_home", "centrality",
  "own_frontier", "opponent_frontier_lead",
]);
const MODEL_URL = new URL("./assets/research-ai/three-player-policy-v1.json?v=20261025-room1", import.meta.url);
let modelPromise = null;

function counts(engine, player) {
  const states = engine._getPlayerStates(player);
  const nodes = engine._getPlayerNodes(player).length;
  const lines = engine._getPlayerLines(player).length;
  const frontier = new Set();
  for (const point of engine.validPositions) {
    if (![states.node, states.line].includes(engine._getState(point))) continue;
    for (const neighbor of engine.getAdjacentPositions(point)) {
      if (engine._getState(neighbor) === 0) frontier.add(neighbor.join(","));
    }
  }
  return { nodes, coverage: nodes + lines, reach: fastTerritoryBFS(engine, player), frontier: frontier.size };
}

function stateFeatures(engine) {
  return Object.fromEntries(engine.activePlayers.map((player) => [player, counts(engine, player)]));
}

function featuresForMove(engine, player, point, before, after, previousState) {
  const count = engine.validPositions.length;
  const opponents = engine.activePlayers.filter((other) => other !== player && !engine.resignedPlayers?.has(other));
  const own = after[player];
  const maximum = (field) => Math.max(0, ...opponents.map((other) => after[other][field]));
  const lost = (field) => opponents.reduce((total, other) => total + before[other][field] - after[other][field], 0);
  const scale = engine.gridSize - 1;
  const home = engine.initialPositions[player];
  const dx = point[0] - home[0], dy = point[1] - home[1];
  const distance = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dx + dy)) / scale;
  const barycentric = [point[0], point[1], scale - point[0] - point[1]];
  return [
    own.nodes / count, own.coverage / count, own.reach / count,
    (own.nodes - maximum("nodes")) / count,
    (own.coverage - maximum("coverage")) / count,
    (own.reach - maximum("reach")) / count,
    lost("nodes") / count, lost("coverage") / count,
    (own.nodes - before[player].nodes) / count,
    (own.coverage - before[player].coverage) / count,
    Number(opponents.some((other) => previousState === engine._getPlayerStates(other).line)),
    Number(previousState === engine._getPlayerStates(player).line),
    distance, 3 * Math.min(...barycentric) / scale,
    own.frontier / count, (own.frontier - maximum("frontier")) / count,
  ];
}

// The same Web rule engine supplies both training transitions and production
// legal masks, including Superko history. Speculation is always rolled back.
export function threePlayerCandidates(engine, player = engine.currentPlayer) {
  if (engine.currentPlayer !== player) throw new Error("AI 只能分析当前行动方。");
  if (engine.gameOver) return [];
  const snapshot = saveState(engine);
  const replayFlag = engine._isReplayingBatch;
  engine._isReplayingBatch = true;
  try {
    const before = stateFeatures(engine);
    const candidates = [];
    const legal = engine.getLegalMoves(player);
    for (const { point } of legal) {
      restoreState(engine, snapshot);
      const previousState = engine._getState(point);
      if (!engine.playMove(point).success) continue;
      const after = stateFeatures(engine);
      candidates.push({ point: [...point], features: featuresForMove(engine, player, point, before, after, previousState) });
    }
    return candidates;
  } finally {
    restoreState(engine, snapshot);
    engine._isReplayingBatch = replayFlag;
  }
}

export function createThreePlayerModel(payload) {
  if (payload?.schema?.name !== "lifeline-three-player-policy" || payload.schema.version !== 1
      || payload.id !== THREE_PLAYER_MODEL_ID || payload.rules_version !== "territory-v2"
      || JSON.stringify(payload.features) !== JSON.stringify(THREE_PLAYER_FEATURES)
      || !Array.isArray(payload.weights) || payload.weights.length !== THREE_PLAYER_FEATURES.length
      || !payload.weights.every((value) => Number.isFinite(value) && Math.abs(value) < 10000)
      || !Number.isFinite(payload.temperature) || payload.temperature <= 0
      || !Number.isInteger(payload.training?.three_player_samples) || payload.training.three_player_samples < 1
      || !Number.isInteger(payload.training?.two_player_samples) || payload.training.two_player_samples < 1) {
    throw new Error("三人 AI 模型格式或训练来源无效。");
  }
  const spec = structuredClone(payload);
  return {
    spec,
    score(features) {
      return features.reduce((sum, value, index) => sum + value * spec.weights[index], 0) / spec.temperature;
    },
  };
}

export async function loadThreePlayerModel(id = THREE_PLAYER_MODEL_ID) {
  if (id !== THREE_PLAYER_MODEL_ID) throw new Error(`未找到三人 AI 模型：${id}`);
  if (!modelPromise) modelPromise = (async () => {
    const response = await fetch(MODEL_URL);
    if (!response.ok) throw new Error(`无法加载三人 AI 模型（HTTP ${response.status}）。`);
    return createThreePlayerModel(await response.json());
  })().catch((error) => { modelPromise = null; throw error; });
  return modelPromise;
}

export class ThreePlayerAI {
  constructor(model) { this.model = model; }

  getTopMoves(engine, player, topN = 5) {
    if (engine.playerCount !== 3 || !["territory-v2", "territory-v3"].includes(engine.rulesVersion)
        || engine.gridSize < 5 || engine.gridSize > 15) {
      throw new Error("三人 AI 需要 5–15 边长的 territory-v2 三人对局。");
    }
    const candidates = threePlayerCandidates(engine, player);
    if (!candidates.length) return [];
    const logits = candidates.map((candidate) => this.model.score(candidate.features));
    if (!logits.every(Number.isFinite)) throw new Error("三人 AI 评分无效。");
    const maximum = Math.max(...logits);
    const exponentials = logits.map((score) => Math.exp(score - maximum));
    const total = exponentials.reduce((sum, value) => sum + value, 0);
    return candidates.map((candidate, index) => ({
      point: candidate.point, score: logits[index], prior: exponentials[index] / total, visits: 1,
    })).sort((a, b) => b.score - a.score || a.point[1] - b.point[1] || a.point[0] - b.point[0])
      .slice(0, Math.max(0, Math.floor(topN)));
  }
}
