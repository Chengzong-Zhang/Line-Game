const manifestUrl = new URL("./assets/research-ai/model-free-manifest.json", import.meta.url);
let manifestPromise = null;
const modelPromises = new Map();
const MAX_POINTS = 120;
const ACTION_COUNT = 121;
const FEATURES_PER_POINT = 7;

function keyFor(point) { return `${point[0]},${point[1]}`; }

async function digestHex(buffer) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function loadManifest() {
  if (!manifestPromise) manifestPromise = fetch(manifestUrl).then(async (response) => {
    if (!response.ok) throw new Error(`无法加载 model-free 模型清单（HTTP ${response.status}）。`);
    const manifest = await response.json();
    if (manifest?.schema?.name !== "lifeline-web-model-free" || !Array.isArray(manifest.models)) throw new Error("model-free 模型清单格式无效。");
    return manifest;
  });
  return manifestPromise;
}

function tensorMap(spec, raw) {
  if (!(raw instanceof ArrayBuffer) || raw.byteLength !== spec.float_count * 4) throw new Error(`模型权重大小不匹配：${spec.id}`);
  const values = new Float32Array(raw); const tensors = new Map();
  for (const tensor of spec.tensors) tensors.set(tensor.name, values.subarray(tensor.offset, tensor.offset + tensor.length));
  return tensors;
}

function linear(input, inputSize, outputSize, weight, bias) {
  const result = new Float32Array(outputSize);
  for (let out = 0; out < outputSize; out += 1) {
    let total = bias ? bias[out] : 0; const offset = out * inputSize;
    for (let index = 0; index < inputSize; index += 1) total += weight[offset + index] * input[index];
    result[out] = total;
  }
  return result;
}

function relu(values) { return values.map((value) => Math.max(0, value)); }

function encode(engine) {
  const player = engine.currentPlayer; const opponents = engine._getOpponents(player);
  if (engine.playerCount !== 2 || !opponents.length) throw new Error("model-free 网页模型仅支持双人局面。");
  const opponent = opponents[0]; const own = engine._getPlayerStates(player); const enemy = engine._getPlayerStates(opponent);
  const features = new Float32Array(MAX_POINTS * FEATURES_PER_POINT); const scale = Math.max(1, engine.gridSize - 1);
  for (let index = 0; index < engine.validPositions.length; index += 1) {
    const [x, y] = engine.validPositions[index]; const state = engine._getState([x, y]); const offset = index * FEATURES_PER_POINT;
    features[offset] = Number(state === 0); features[offset + 1] = Number(state === own.node); features[offset + 2] = Number(state === own.line);
    features[offset + 3] = Number(state === enemy.node); features[offset + 4] = Number(state === enemy.line); features[offset + 5] = x / scale; features[offset + 6] = y / scale;
  }
  const state = new Float32Array(MAX_POINTS * FEATURES_PER_POINT + 2); state.set(features); state[state.length - 2] = engine.gridSize / 15; state[state.length - 1] = Math.min(Math.max(engine.consecutiveSkips, 0), 2) / 2;
  const legal = engine.getLegalMoves(player).map((move) => engine._keyToIdx.get(keyFor(move.point))).filter(Number.isInteger);
  legal.push(engine.validPositions.length); return { state, legal };
}

class ModelFreeModel {
  constructor(spec, tensors) { this.spec = spec; this.tensors = tensors; }
  tensor(name) { const value = this.tensors.get(name); if (!value) throw new Error(`模型缺少张量：${name}`); return value; }
  forwardBody(state) {
    let hidden = relu(linear(state, 842, 512, this.tensor(this.spec.model_family === "dqn" ? "layers.0.weight" : "body.0.weight"), this.tensor(this.spec.model_family === "dqn" ? "layers.0.bias" : "body.0.bias")));
    hidden = relu(linear(hidden, hidden.length, hidden.length, this.tensor(this.spec.model_family === "dqn" ? "layers.2.weight" : "body.2.weight"), this.tensor(this.spec.model_family === "dqn" ? "layers.2.bias" : "body.2.bias")));
    return hidden;
  }
  logits(state) {
    const hidden = this.forwardBody(state); const prefix = this.spec.model_family === "dqn" ? "layers.4" : (this.spec.model_family === "ppo" || this.spec.model_family === "gail" || this.spec.model_family === "gan" ? "policy" : "head");
    return linear(hidden, hidden.length, ACTION_COUNT, this.tensor(`${prefix}.weight`), this.tensor(`${prefix}.bias`));
  }
  evaluate(engine) {
    const { state, legal } = encode(engine); const logits = this.logits(state); const max = Math.max(...legal.map((index) => logits[index])); const exp = legal.map((index) => Math.exp(logits[index] - max)); const total = exp.reduce((sum, value) => sum + value, 0);
    return { priors: legal.filter((index) => index < engine.validPositions.length).map((index, order) => ({ point: [...engine.validPositions[index]], prior: exp[order] / total })) };
  }
}

export async function loadModelFreeModel(id) {
  if (!modelPromises.has(id)) modelPromises.set(id, (async () => {
    const manifest = await loadManifest(); const spec = manifest.models.find((item) => item.id === id); if (!spec) throw new Error(`未找到 model-free 模型：${id}`);
    const response = await fetch(new URL(`./assets/research-ai/${spec.asset}`, import.meta.url)); if (!response.ok) throw new Error(`无法加载 ${spec.label} 权重。`); const raw = await response.arrayBuffer(); const actual = await digestHex(raw); if (actual && actual !== spec.asset_sha256) throw new Error(`${spec.label} 权重哈希不匹配。`); return new ModelFreeModel(spec, tensorMap(spec, raw));
  })());
  return modelPromises.get(id);
}

export class ModelFreeAI {
  constructor(model, options = {}) { this.model = model; this.simulations = options.simulations ?? 1; }
  getTopMoves(engine, aiPlayer, topN = 3) {
    if (engine.currentPlayer !== aiPlayer) throw new Error("model-free AI 只能分析当前行棋方。");
    return this.model.evaluate(engine).priors.sort((left, right) => right.prior - left.prior).slice(0, topN).map((move) => ({ ...move, score: move.prior, meanValue: move.prior, visits: 1 }));
  }
}
