// Source: frozen deployed r4 HexPlayerAI.js, SHA-256 62340c349b53a13e20d47171187228a2359c5d8dcbf12344a4bf6a0017b9f673.
// Compatibility only: lazy browser URL, injected SHA-256 of insertion-order JSON, JSON clone.
// Candidate generation, features, weights, ranking, and model validation are unchanged.
import { restoreState, saveState } from "./AIEngine.js?v=20261020-three1";

export const HEX_PLAYER_MODEL_ID = "hex-player-policy-v1";
export const HEX_PLAYER_FEATURES = Object.freeze([
  "own_nodes", "own_coverage", "own_reach", "node_lead", "coverage_lead",
  "reach_lead", "captured_nodes", "captured_coverage", "own_node_gain",
  "own_coverage_gain", "attack", "own_line", "distance_from_home", "centrality",
  "own_frontier", "opponent_frontier_lead",
]);
const MODEL_PATH = "./assets/research-ai/hex-player-policy-v1.json?v=20261021-hexai1";
let modelPromise = null;

// Integer-index scans avoid constructing coordinate strings for each player's
// reachability and frontier at every candidate on the 631-point maximum board.
function stateFeatures(engine) {
  const points = engine.validPositions;
  const states = Uint8Array.from(points, (point) => engine._getState(point));
  const result = {};
  for (const player of engine.activePlayers) {
    const { node, line } = engine._getPlayerStates(player);
    const visited = new Uint8Array(points.length);
    const frontier = new Set();
    const queue = new Int32Array(points.length);
    let count = 0;
    let nodes = 0;
    for (let index = 0; index < points.length; index += 1) {
      if (states[index] !== node && states[index] !== line) continue;
      if (states[index] === node) nodes += 1;
      visited[index] = 1;
      queue[count++] = index;
      for (const adjacent of engine._adjIdxList[index]) {
        if (states[adjacent] === 0) frontier.add(adjacent);
      }
    }
    const coverage = count;
    for (let head = 0; head < count; head += 1) {
      for (const adjacent of engine._adjIdxList[queue[head]]) {
        if (visited[adjacent] || (states[adjacent] !== 0
          && states[adjacent] !== node && states[adjacent] !== line)) continue;
        visited[adjacent] = 1;
        queue[count++] = adjacent;
      }
    }
    result[player] = { nodes, coverage, reach: count, frontier: frontier.size };
  }
  return result;
}

function moveFeatures(engine, player, point, before, after, previousState) {
  const count = engine.validPositions.length;
  const opponents = engine.activePlayers.filter((other) => other !== player && !engine.resignedPlayers.has(other));
  const own = after[player];
  const maximum = (field) => Math.max(0, ...opponents.map((other) => after[other][field]));
  const lost = (field) => opponents.reduce((sum, other) => sum + before[other][field] - after[other][field], 0);
  const radius = engine.gridSize - 1;
  const home = engine.initialPositions[player];
  const axialDistance = (dx, dy) => Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dx + dy));
  const isHex = engine.playerCount >= 4;
  const centrality = isHex
    ? 1 - axialDistance(point[0] - radius, point[1] - radius) / radius
    : 3 * Math.min(point[0], point[1], radius - point[0] - point[1]) / radius;
  return [
    own.nodes / count, own.coverage / count, own.reach / count,
    (own.nodes - maximum("nodes")) / count, (own.coverage - maximum("coverage")) / count,
    (own.reach - maximum("reach")) / count, lost("nodes") / count, lost("coverage") / count,
    (own.nodes - before[player].nodes) / count, (own.coverage - before[player].coverage) / count,
    Number(opponents.some((other) => previousState === engine._getPlayerStates(other).line)),
    Number(previousState === engine._getPlayerStates(player).line),
    axialDistance(point[0] - home[0], point[1] - home[1]) / (radius * (isHex ? 2 : 1)),
    centrality, own.frontier / count, (own.frontier - maximum("frontier")) / count,
  ];
}

// Training may also call this on the legacy two-seat triangle for pretraining.
// Features use the same relative meaning, with shape-specific distance bounds.
export function hexPlayerCandidates(engine, player = engine.currentPlayer) {
  if (engine.currentPlayer !== player) throw new Error("AI 只能分析当前行动方。");
  if (engine.gameOver || engine.resignedPlayers.has(player)) return [];
  const snapshot = saveState(engine);
  const replayFlag = engine._isReplayingBatch;
  const autoSkip = engine._checkAndAutoSkip;
  const ownsAutoSkip = Object.prototype.hasOwnProperty.call(engine, "_checkAndAutoSkip");
  engine._isReplayingBatch = true;
  // Features only read resulting board topology. Successive-turn normalization
  // is unnecessary here; actual play still uses the unmodified engine method.
  engine._checkAndAutoSkip = () => {};
  try {
    const before = stateFeatures(engine);
    const legal = engine.getLegalMoves(player);
    const candidates = [];
    for (const { point } of legal) {
      restoreState(engine, snapshot);
      const previousState = engine._getState(point);
      if (!engine.playMove(point).success) continue;
      const after = stateFeatures(engine);
      candidates.push({
        point: [...point],
        features: moveFeatures(engine, player, point, before, after, previousState),
      });
    }
    return candidates;
  } finally {
    restoreState(engine, snapshot);
    engine._isReplayingBatch = replayFlag;
    if (ownsAutoSkip) engine._checkAndAutoSkip = autoSkip;
    else delete engine._checkAndAutoSkip;
  }
}

export async function createHexPlayerModel(payload, hashText) {
  if (payload?.schema?.name !== "lifeline-hex-player-policy" || payload.schema.version !== 1
    || payload.id !== HEX_PLAYER_MODEL_ID || payload.rules_version !== "territory-v2"
    || JSON.stringify(payload.features) !== JSON.stringify(HEX_PLAYER_FEATURES)
    || JSON.stringify(payload.browser_inference?.player_counts) !== "[4,5,6]"
    || JSON.stringify(payload.browser_inference?.board_size_range) !== "[5,15]"
    || !Array.isArray(payload.weights) || payload.weights.length !== HEX_PLAYER_FEATURES.length
    || !payload.weights.every((value) => Number.isFinite(value) && Math.abs(value) < 10000)
    || !Number.isFinite(payload.temperature) || payload.temperature <= 0
    || !Number.isInteger(payload.training?.two_player_samples) || payload.training.two_player_samples < 1
    || [4, 5, 6].some((count) => !Number.isInteger(payload.training?.hex_samples_by_count?.[count])
      || payload.training.hex_samples_by_count[count] < 1)
    || payload.integrity?.algorithm !== "SHA-256"
    || !/^[a-f0-9]{64}$/.test(payload.integrity?.payload_sha256 ?? "")) {
    throw new Error("六边形 AI 模型格式或训练来源无效。");
  }
  const body = { ...payload };
  delete body.integrity;
  let hash;
  if (hashText) hash = await hashText(JSON.stringify(body));
  else {
    if (!globalThis.crypto?.subtle) throw new Error("无法校验六边形 AI 模型完整性。");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body)));
    hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  }
  if (hash !== payload.integrity.payload_sha256) throw new Error("六边形 AI 模型完整性校验失败。");
  const spec = JSON.parse(JSON.stringify(payload));
  Object.freeze(spec.weights);
  return {
    spec,
    score(features) {
      if (!Array.isArray(features) || features.length !== HEX_PLAYER_FEATURES.length
        || !features.every(Number.isFinite)) throw new Error("六边形 AI 特征无效。");
      return features.reduce((sum, value, index) => sum + value * spec.weights[index], 0) / spec.temperature;
    },
  };
}

export async function loadHexPlayerModel(id = HEX_PLAYER_MODEL_ID) {
  if (id !== HEX_PLAYER_MODEL_ID) throw new Error(`未找到六边形 AI 模型：${id}`);
  if (!modelPromise) modelPromise = (async () => {
    const response = await fetch(new URL(MODEL_PATH, import.meta.url));
    if (!response.ok) throw new Error(`无法加载六边形 AI 模型（HTTP ${response.status}）。`);
    return createHexPlayerModel(await response.json());
  })().catch((error) => { modelPromise = null; throw error; });
  return modelPromise;
}

export class HexPlayerAI {
  constructor(model) { this.model = model; }

  getTopMoves(engine, player, topN = 5) {
    if (![4, 5, 6].includes(engine.playerCount) || !["territory-v2", "territory-v3"].includes(engine.rulesVersion)
      || engine.gridSize < 5 || engine.gridSize > 15) {
      throw new Error("六边形 AI 需要边长 5–15、4–6 人的 territory-v2 对局。");
    }
    const candidates = hexPlayerCandidates(engine, player);
    if (!candidates.length) return [];
    const logits = candidates.map((candidate) => this.model.score(candidate.features));
    if (!logits.every(Number.isFinite)) throw new Error("六边形 AI 评分无效。");
    const maximum = Math.max(...logits);
    const exponentials = logits.map((score) => Math.exp(score - maximum));
    const total = exponentials.reduce((sum, value) => sum + value, 0);
    return candidates.map((candidate, index) => ({
      point: candidate.point, score: logits[index], prior: exponentials[index] / total, visits: 1,
    })).sort((a, b) => b.score - a.score || a.point[1] - b.point[1] || a.point[0] - b.point[0])
      .slice(0, Math.max(0, Math.floor(topN)));
  }
}
