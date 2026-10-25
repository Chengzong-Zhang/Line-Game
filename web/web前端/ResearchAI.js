import { saveState, restoreState } from "./AIEngine.js?v=20261025-terminal-v4";
import { GameEngine } from "./GameEngine.js?v=20261025-terminal-v4";

const FEATURE_COUNT = 11;
const EPSILON = 1e-5;
const DEFAULT_WEB_INFERENCE_BOARD_SIZE_RANGE = Object.freeze([5, 15]);
const manifestUrl = new URL("./assets/research-ai/manifest.json", import.meta.url);
const transferManifestUrl = new URL("./assets/research-ai/transfer-v1/manifest.json", import.meta.url);
let manifestPromise = null;
const modelPromises = new Map();

function keyFor(point) {
  return `${point[0]},${point[1]}`;
}

function webInferenceBoardSizeRange(spec) {
  const candidate = spec?.browser_inference?.board_size_range;
  if (!Array.isArray(candidate) || candidate.length !== 2
    || !candidate.every(Number.isInteger) || candidate[0] > candidate[1]) {
    return DEFAULT_WEB_INFERENCE_BOARD_SIZE_RANGE;
  }
  return candidate;
}

export function supportsResearchInference(spec, engine) {
  // A v2 policy may be tried on v3 positions; this is runtime compatibility,
  // not evidence of strength or calibration under the new terminal score.
  const [minimumSize, maximumSize] = webInferenceBoardSizeRange(spec);
  return engine?.playerCount === 2
    && Number.isInteger(engine?.gridSize)
    && engine.gridSize >= minimumSize
    && engine.gridSize <= maximumSize
    && (!spec?.browser_inference?.rules_versions
      || spec.browser_inference.rules_versions.includes(engine.rulesVersion)
      || (engine.rulesVersion === "territory-v3"
        && spec.browser_inference.rules_versions.includes("territory-v2")));
}

export function describeResearchInferenceRange(spec) {
  const [minimumSize, maximumSize] = webInferenceBoardSizeRange(spec);
  return `${minimumSize}–${maximumSize}`;
}

function relu(value) {
  return value > 0 ? value : 0;
}

function tensorMap(spec, raw) {
  const channels = spec.network?.hidden_channels;
  const layers = spec.network?.message_passing_layers;
  if (!["padded_cnn", "grid_gnn", "topology_gnn"].includes(spec.model_kind)
    || spec.observation_mode !== (spec.model_kind === "topology_gnn" ? "topology" : "grid_graph")
    || !Number.isInteger(channels) || channels < 4 || !Number.isInteger(layers) || layers < 1) {
    throw new Error(`模型网络配置无效：${spec.id}`);
  }
  const expected = [];
  const add = (name, shape) => expected.push({ name, shape });
  add("input_projection.weight", spec.model_kind === "padded_cnn" ? [channels, FEATURE_COUNT, 1, 1] : [channels, FEATURE_COUNT]);
  add("input_projection.bias", [channels]);
  for (let layer = 0; layer < layers; layer++) {
    const prefix = `blocks.${layer}`;
    if (spec.model_kind === "padded_cnn") {
      for (const part of ["first", "second"]) { add(`${prefix}.${part}.weight`, [channels, channels, 3, 3]); add(`${prefix}.${part}.bias`, [channels]); }
    } else {
      add(`${prefix}.self_projection.weight`, [channels, channels]); add(`${prefix}.self_projection.bias`, [channels]);
      for (let relation = 0; relation < (spec.model_kind === "topology_gnn" ? 3 : 1); relation++) add(`${prefix}.relation_projections.${relation}.weight`, [channels, channels]);
      add(`${prefix}.normalization.weight`, [channels]); add(`${prefix}.normalization.bias`, [channels]);
    }
  }
  for (const head of ["point_policy", "pass_policy", "value_head"]) {
    add(`${head}.0.weight`, [channels, channels]); add(`${head}.0.bias`, [channels]);
    add(`${head}.2.weight`, [1, channels]); add(`${head}.2.bias`, [1]);
  }
  if (!Array.isArray(spec.tensors) || spec.tensors.length !== expected.length
    || !expected.every((t, i) => t.name === spec.tensors[i].name && JSON.stringify(t.shape) === JSON.stringify(spec.tensors[i].shape))) {
    throw new Error(`模型张量顺序或形状不匹配：${spec.id}`);
  }
  if (!(raw instanceof ArrayBuffer) || raw.byteLength !== spec.float_count * 4) {
    throw new Error(`模型权重大小不匹配：${spec.id}`);
  }
  // Decode explicitly: the export format is little-endian on every platform.
  const view = new DataView(raw);
  const values = Float32Array.from({ length: spec.float_count }, (_, i) => view.getFloat32(i * 4, true));
  if (!values.every(Number.isFinite)) throw new Error(`模型权重包含非有限值：${spec.id}`);
  const tensors = new Map();
  let offset = 0;
  for (const tensor of spec.tensors) {
    if (!Array.isArray(tensor.shape) || !tensor.shape.every((n) => Number.isInteger(n) && n > 0)
      || tensor.shape.reduce((a, b) => a * b, 1) !== tensor.length
      || tensor.offset !== offset || tensors.has(tensor.name)
      || tensor.offset + tensor.length > values.length) {
      throw new Error(`模型张量清单无效：${spec.id}`);
    }
    tensors.set(tensor.name, values.subarray(tensor.offset, tensor.offset + tensor.length));
    offset += tensor.length;
  }
  if (offset !== values.length) throw new Error(`模型张量清单不完整：${spec.id}`);
  return tensors;
}

async function digestHex(buffer) {
  if (!globalThis.crypto?.subtle) throw new Error("模型 SHA-256 校验需要安全浏览器上下文（HTTPS 或 localhost）。");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

export async function loadResearchManifest() {
  if (!manifestPromise) {
    const readManifest = async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`无法加载研究模型清单（HTTP ${response.status}）。`);
      const manifest = await response.json();
      if (manifest?.schema?.name !== "lifeline-web-research-ai" || manifest?.schema?.version !== 1
        || !Array.isArray(manifest.models)) {
        throw new Error("研究模型清单格式不受支持。");
      }
      return manifest;
    };
    manifestPromise = Promise.all([readManifest(manifestUrl), readManifest(transferManifestUrl)]).then(([legacy, transfer]) => {
      const models = [...legacy.models, ...transfer.models];
      if (new Set(models.map((spec) => spec.id)).size !== models.length) throw new Error("研究模型 ID 重复。");
      return { ...legacy, models, default_seed: transfer.default_seed, default_selection_basis: transfer.default_selection_basis };
    }).catch((error) => { manifestPromise = null; throw error; });
  }
  return manifestPromise;
}

export async function loadResearchModel(id) {
  if (!modelPromises.has(id)) {
    modelPromises.set(id, (async () => {
      const manifest = await loadResearchManifest();
      const spec = manifest.models.find((candidate) => candidate.id === id);
      if (!spec) throw new Error(`未找到研究模型：${id}`);
      const response = await fetch(new URL(`./assets/research-ai/${spec.asset}`, import.meta.url));
      if (!response.ok) throw new Error(`无法加载 ${spec.label} 权重（HTTP ${response.status}）。`);
      const raw = await response.arrayBuffer();
      const actualHash = await digestHex(raw);
      if (actualHash !== spec.asset_sha256) {
        throw new Error(`${spec.label} 权重哈希不匹配。`);
      }
      return createResearchModel(spec, raw);
    })().catch((error) => { modelPromises.delete(id); throw error; }));
  }
  return modelPromises.get(id);
}

export function createResearchModel(spec, raw) {
  return new ResearchPolicyValueModel(spec, tensorMap(spec, raw));
}

function linear(input, inputSize, outputSize, weight, bias) {
  const output = new Float32Array(outputSize);
  for (let out = 0; out < outputSize; out += 1) {
    let total = bias ? bias[out] : 0;
    const offset = out * inputSize;
    for (let index = 0; index < inputSize; index += 1) total += weight[offset + index] * input[index];
    output[out] = total;
  }
  return output;
}

function applyLayerNorm(values, channels, weight, bias) {
  for (let offset = 0; offset < values.length; offset += channels) {
    let mean = 0;
    for (let channel = 0; channel < channels; channel += 1) mean += values[offset + channel];
    mean /= channels;
    let variance = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const delta = values[offset + channel] - mean;
      variance += delta * delta;
    }
    const scale = 1 / Math.sqrt(variance / channels + EPSILON);
    for (let channel = 0; channel < channels; channel += 1) {
      values[offset + channel] = (values[offset + channel] - mean) * scale * weight[channel] + bias[channel];
    }
  }
}

export function researchRelations(engine, player, topology) {
  const nodes = engine.validPositions.length;
  const relations = [engine._adjIdxList.map((neighbors) => [...neighbors]), [], []];
  if (topology) {
    const opponent = engine._getOpponents(player)[0];
    for (const [relationIndex, owner] of [[1, player], [2, opponent]]) {
      for (const edge of engine.edges[owner] ?? []) {
        const [left, right] = String(edge).split("|");
        const a = engine._keyToIdx.get(left);
        const b = engine._keyToIdx.get(right);
        if (Number.isInteger(a) && Number.isInteger(b)) {
          relations[relationIndex][a] ??= [];
          relations[relationIndex][b] ??= [];
          relations[relationIndex][a].push(b);
          relations[relationIndex][b].push(a);
        }
      }
    }
  }
  for (let relation = 0; relation < relations.length; relation += 1) {
    for (let node = 0; node < nodes; node += 1) relations[relation][node] ??= [];
  }
  return relations.map((relation) => relation.map((neighbors) => [...new Set(neighbors)].sort((a, b) => a - b)));
}

export function encodeResearchPosition(engine) {
  if (engine.playerCount !== 2 || engine.gameOver) throw new Error("研究模型仅接受非终局双人局面。");
  const player = engine.currentPlayer;
  const opponent = engine._getOpponents(player)[0];
  if (!opponent) throw new Error("研究神经模型仅支持双人局面。");
  const ownStates = engine._getPlayerStates(player);
  const opponentStates = engine._getPlayerStates(opponent);
  const nodeCount = engine.validPositions.length;
  const features = new Float32Array(nodeCount * FEATURE_COUNT);
  const sideScale = engine.gridSize - 1;
  const ownStart = engine._keyToIdx.get(keyFor(engine.initialPositions[player]));
  const opponentStart = engine._keyToIdx.get(keyFor(engine.initialPositions[opponent]));
  for (let index = 0; index < nodeCount; index += 1) {
    const [x, y] = engine.validPositions[index];
    const state = engine._getState([x, y]);
    const offset = index * FEATURE_COUNT;
    features[offset] = Number(state === 0);
    features[offset + 1] = Number(state === ownStates.node);
    features[offset + 2] = Number(state === ownStates.line);
    features[offset + 3] = Number(state === opponentStates.node);
    features[offset + 4] = Number(state === opponentStates.line);
    features[offset + 5] = x / sideScale;
    features[offset + 6] = y / sideScale;
    features[offset + 7] = Number(x === 0 || y === 0 || x + y === engine.gridSize - 1);
    features[offset + 8] = Number(index === ownStart);
    features[offset + 9] = Number(index === opponentStart);
    features[offset + 10] = Math.min(Math.max(engine.consecutiveSkips, 0), 2) / 2;
  }
  const legal = engine.getLegalMoves(player).map((move) => engine._keyToIdx.get(keyFor(move.point)));
  return { features, legal, player, passIndex: nodeCount };
}

class ResearchPolicyValueModel {
  constructor(spec, tensors) {
    this.spec = spec;
    this.tensors = tensors;
    this.channels = spec.network.hidden_channels;
    this.layers = spec.network.message_passing_layers;
  }

  tensor(name) {
    const value = this.tensors.get(name);
    if (!value) throw new Error(`模型缺少张量：${name}`);
    return value;
  }

  applyHeads(hidden, nodeCount) {
    const channels = this.channels;
    const pointScores = new Float32Array(nodeCount);
    for (let node = 0; node < nodeCount; node += 1) {
      const first = linear(hidden.subarray(node * channels, (node + 1) * channels), channels, channels,
        this.tensor("point_policy.0.weight"), this.tensor("point_policy.0.bias"));
      for (let index = 0; index < channels; index += 1) first[index] = relu(first[index]);
      pointScores[node] = linear(first, channels, 1, this.tensor("point_policy.2.weight"), this.tensor("point_policy.2.bias"))[0];
    }
    const pooled = new Float32Array(channels);
    for (let index = 0; index < hidden.length; index += 1) pooled[index % channels] += hidden[index] / nodeCount;
    const valueHidden = linear(pooled, channels, channels, this.tensor("value_head.0.weight"), this.tensor("value_head.0.bias"));
    for (let index = 0; index < channels; index += 1) valueHidden[index] = relu(valueHidden[index]);
    const value = Math.tanh(linear(valueHidden, channels, 1, this.tensor("value_head.2.weight"), this.tensor("value_head.2.bias"))[0]);
    const passHidden = linear(pooled, channels, channels, this.tensor("pass_policy.0.weight"), this.tensor("pass_policy.0.bias"));
    for (let index = 0; index < channels; index += 1) passHidden[index] = relu(passHidden[index]);
    const passScore = linear(passHidden, channels, 1, this.tensor("pass_policy.2.weight"), this.tensor("pass_policy.2.bias"))[0];
    return { pointScores, passScore, value };
  }

  forwardGnn(engine, encoded) {
    const nodes = engine.validPositions.length;
    const channels = this.channels;
    let hidden = new Float32Array(nodes * channels);
    for (let node = 0; node < nodes; node += 1) {
      const projected = linear(encoded.features.subarray(node * FEATURE_COUNT, (node + 1) * FEATURE_COUNT), FEATURE_COUNT, channels,
        this.tensor("input_projection.weight"), this.tensor("input_projection.bias"));
      for (let channel = 0; channel < channels; channel += 1) hidden[node * channels + channel] = relu(projected[channel]);
    }
    const relations = researchRelations(engine, encoded.player, this.spec.model_kind === "topology_gnn");
    const relationCount = this.spec.model_kind === "topology_gnn" ? 3 : 1;
    for (let layer = 0; layer < this.layers; layer += 1) {
      const update = new Float32Array(nodes * channels);
      const selfWeight = this.tensor(`blocks.${layer}.self_projection.weight`);
      const selfBias = this.tensor(`blocks.${layer}.self_projection.bias`);
      for (let node = 0; node < nodes; node += 1) {
        update.set(linear(hidden.subarray(node * channels, (node + 1) * channels), channels, channels, selfWeight, selfBias), node * channels);
      }
      for (let relation = 0; relation < relationCount; relation += 1) {
        const weight = this.tensor(`blocks.${layer}.relation_projections.${relation}.weight`);
        for (let node = 0; node < nodes; node += 1) {
          const aggregate = new Float32Array(channels);
          const neighbors = relations[relation][node];
          if (neighbors.length) {
            for (const neighbor of neighbors) for (let channel = 0; channel < channels; channel += 1) aggregate[channel] += hidden[neighbor * channels + channel] / neighbors.length;
          }
          const projected = linear(aggregate, channels, channels, weight, null);
          for (let channel = 0; channel < channels; channel += 1) update[node * channels + channel] += projected[channel];
        }
      }
      for (let index = 0; index < update.length; index += 1) update[index] = hidden[index] + relu(update[index]);
      applyLayerNorm(update, channels, this.tensor(`blocks.${layer}.normalization.weight`), this.tensor(`blocks.${layer}.normalization.bias`));
      hidden = update;
    }
    return this.applyHeads(hidden, nodes);
  }

  conv3(input, side, weight, bias) {
    const channels = this.channels;
    const output = new Float32Array(input.length);
    for (let out = 0; out < channels; out += 1) for (let y = 0; y < side; y += 1) for (let x = 0; x < side; x += 1) {
      let total = bias[out];
      for (let inner = 0; inner < channels; inner += 1) for (let ky = 0; ky < 3; ky += 1) for (let kx = 0; kx < 3; kx += 1) {
        const sourceY = y + ky - 1;
        const sourceX = x + kx - 1;
        if (sourceY >= 0 && sourceY < side && sourceX >= 0 && sourceX < side) {
          total += weight[((out * channels + inner) * 3 + ky) * 3 + kx] * input[(inner * side + sourceY) * side + sourceX];
        }
      }
      output[(out * side + y) * side + x] = total;
    }
    return output;
  }

  forwardCnn(engine, encoded) {
    const side = engine.gridSize;
    const channels = this.channels;
    const nodeCount = engine.validPositions.length;
    let hidden = new Float32Array(channels * side * side);
    const inputWeight = this.tensor("input_projection.weight");
    const inputBias = this.tensor("input_projection.bias");
    for (let node = 0; node < nodeCount; node += 1) {
      const [x, y] = engine.validPositions[node];
      const projected = linear(encoded.features.subarray(node * FEATURE_COUNT, (node + 1) * FEATURE_COUNT), FEATURE_COUNT, channels, inputWeight, inputBias);
      for (let channel = 0; channel < channels; channel += 1) hidden[(channel * side + y) * side + x] = relu(projected[channel]);
    }
    for (let layer = 0; layer < this.layers; layer += 1) {
      const first = this.conv3(hidden, side, this.tensor(`blocks.${layer}.first.weight`), this.tensor(`blocks.${layer}.first.bias`));
      for (let channel = 0; channel < channels; channel += 1) for (let y = 0; y < side; y += 1) for (let x = 0; x < side; x += 1) {
        const offset = (channel * side + y) * side + x;
        first[offset] = x < side - y ? relu(first[offset]) : 0;
      }
      const second = this.conv3(first, side, this.tensor(`blocks.${layer}.second.weight`), this.tensor(`blocks.${layer}.second.bias`));
      const next = new Float32Array(hidden.length);
      for (let node = 0; node < nodeCount; node += 1) {
        const [x, y] = engine.validPositions[node];
        for (let channel = 0; channel < channels; channel += 1) {
          const offset = (channel * side + y) * side + x;
          next[offset] = relu(hidden[offset] + second[offset]);
        }
      }
      hidden = next;
    }
    const nodes = new Float32Array(nodeCount * channels);
    for (let node = 0; node < nodeCount; node += 1) {
      const [x, y] = engine.validPositions[node];
      for (let channel = 0; channel < channels; channel += 1) nodes[node * channels + channel] = hidden[(channel * side + y) * side + x];
    }
    return this.applyHeads(nodes, nodeCount);
  }

  evaluate(engine) {
    if (!supportsResearchInference(this.spec, engine)) {
      throw new Error(`${this.spec.label} 仅支持双人 ${describeResearchInferenceRange(this.spec)} 边长棋盘。`);
    }
    const encoded = encodeResearchPosition(engine);
    const result = this.spec.model_kind === "padded_cnn" ? this.forwardCnn(engine, encoded) : this.forwardGnn(engine, encoded);
    if (![result.value, result.passScore, ...result.pointScores].every(Number.isFinite)) throw new Error("模型前向产生了非有限值。");
    const actions = encoded.legal.map((index) => ({ point: [...engine.validPositions[index]], actionIndex: index, logit: result.pointScores[index] }));
    // Preserve the historical point-only candidates for legacy manifests.
    if (this.spec.action_contract?.pass || !actions.length) actions.push({ point: null, actionIndex: encoded.passIndex, logit: result.passScore });
    let max = Number.NEGATIVE_INFINITY;
    for (const action of actions) max = Math.max(max, action.logit);
    const exponentials = actions.map((action) => Math.exp(action.logit - max));
    const total = exponentials.reduce((sum, value) => sum + value, 0);
    return {
      value: result.value,
      pointScores: result.pointScores, passScore: result.passScore,
      priors: actions.map((action, order) => ({ ...action, type: action.point === null ? "pass" : "move", prior: exponentials[order] / total })),
    };
  }
}

export class NeuralPUCTAI {
  constructor(model, { simulations = 16, cPuct = 1.5 } = {}) {
    this.model = model;
    if (!Number.isInteger(simulations) || simulations < 1 || !Number.isFinite(cPuct) || cPuct <= 0) throw new Error("PUCT 搜索预算无效。");
    this.simulations = simulations;
    this.cPuct = cPuct;
  }

  expand(node, engine, rootPlayer) {
    const evaluation = this.model.evaluate(engine);
    node.playerToAct = engine.currentPlayer;
    node.children = evaluation.priors.map(({ point, prior, actionIndex }) => ({ action: point, actionIndex, prior, parent: node, children: null, visits: 0, valueSum: 0, playerToAct: null }));
    return engine.currentPlayer === rootPlayer ? evaluation.value : -evaluation.value;
  }

  select(node, rootPlayer) {
    const sign = node.playerToAct === rootPlayer ? 1 : -1;
    let best = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const child of node.children) {
      const q = child.visits ? child.valueSum / child.visits : 0;
      const score = sign * q + this.cPuct * child.prior * Math.sqrt(Math.max(1, node.visits)) / (1 + child.visits);
      if (score > bestScore + 1e-12) {
        best = child;
        bestScore = score;
      }
    }
    return best;
  }

  getTopMoves(engine, aiPlayer, topN = 3) {
    if (engine.currentPlayer !== aiPlayer) throw new Error("神经 PUCT 只能分析当前行棋方。");
    if (!supportsResearchInference(this.model.spec, engine)) throw new Error("模型不支持此棋盘/规则/玩家数。");
    if (engine.gameOver) return [];
    const previousReplayFlag = engine._isReplayingBatch;
    const rootSnapshot = saveState(engine);
    engine._isReplayingBatch = true;
    try {
      const root = { action: null, prior: 1, parent: null, children: null, visits: 0, valueSum: 0, playerToAct: aiPlayer };
      this.expand(root, engine, aiPlayer);
      for (let simulation = 0; simulation < this.simulations; simulation += 1) {
        restoreState(engine, rootSnapshot);
        let node = root;
        const path = [root];
        let value = 0;
        while (node.children?.length && !engine.gameOver) {
          node = this.select(node, aiPlayer);
          const applied = node.action === null ? engine.skipTurn() : engine.playMove(node.action);
          if (!applied.success) throw new Error("神经 PUCT 生成了非法 Web 动作。");
          path.push(node);
          if (node.children === null && !engine.gameOver) {
            value = this.expand(node, engine, aiPlayer);
            break;
          }
        }
        if (engine.gameOver) {
          // Worker disables display scoring; use the canonical prototype here.
          GameEngine.prototype._updateTerritories.call(engine);
          const winner = engine.getWinner();
          value = winner === "DRAW" ? 0 : winner === aiPlayer ? 1 : -1;
        }
        for (const item of path) {
          item.visits += 1;
          item.valueSum += value;
        }
      }
      return root.children
        .map((child) => ({ point: child.action === null ? null : [...child.action], type: child.action === null ? "pass" : "move", actionIndex: child.actionIndex, score: child.visits ? child.valueSum / child.visits : 0, meanValue: child.visits ? child.valueSum / child.visits : 0, visits: child.visits, prior: child.prior }))
        .sort((left, right) => right.visits - left.visits || right.meanValue - left.meanValue)
        .slice(0, topN);
    } finally {
      restoreState(engine, rootSnapshot);
      engine._isReplayingBatch = previousReplayFlag;
    }
  }
}
