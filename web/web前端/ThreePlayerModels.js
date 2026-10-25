// Keep the frozen v1 implementation intact: both generations use exactly the
// same legal candidates, features and inference budget.
import {
  THREE_PLAYER_FEATURES, ThreePlayerAI, createThreePlayerModel as createV1Model,
  loadThreePlayerModel as loadV1Model,
} from "./ThreePlayerAI.js?v=20261025-ai1";

export { ThreePlayerAI };
// v2 failed the 2026-10-21 promotion gate; see docs/verification/three-player-ai-v2/ARENA_RESULTS.md.
export const DEFAULT_THREE_PLAYER_MODEL_ID = "three-player-policy-v1";
export const THREE_PLAYER_MODEL_HASHES = Object.freeze({
  "three-player-policy-v1": "8cd1a2f36267f96b1e32b7749a9cdc785f489ea7ec12e31aee0beb0a72901794",
  "three-player-policy-v2": "00fc241c500dfd01ff85b5e2a4f1907cc5a9d8307d68bb78be64b0aad129f56e",
});
const promises = new Map();
const isHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function threePlayerModelAsset(id = DEFAULT_THREE_PLAYER_MODEL_ID) {
  if (!Object.hasOwn(THREE_PLAYER_MODEL_HASHES, id)) throw new Error(`未找到三人 AI 模型：${id}`);
  return `assets/research-ai/${id}.json`;
}

export function createSupportedThreePlayerModel(payload) {
  if (payload?.id === "three-player-policy-v1") return createV1Model(payload);
  const training = payload?.training;
  if (payload?.id !== "three-player-policy-v2"
      || payload.schema?.name !== "lifeline-three-player-policy" || payload.schema.version !== 1
      || payload.rules_version !== "territory-v2"
      || JSON.stringify(payload.features) !== JSON.stringify(THREE_PLAYER_FEATURES)
      || !Array.isArray(payload.weights) || payload.weights.length !== THREE_PLAYER_FEATURES.length
      || !payload.weights.every((value) => Number.isFinite(value) && Math.abs(value) < 10000)
      || payload.temperature !== 1
      || !Number.isInteger(training?.posttraining_samples) || training.posttraining_samples < 1
      || !Number.isInteger(training?.validation_samples) || training.validation_samples < 1
      || training.parent_model_id !== "three-player-policy-v1"
      || training.parent_model_sha256 !== THREE_PLAYER_MODEL_HASHES["three-player-policy-v1"]
      || !isHash(training.protocol_sha256)
      || !training.source_hashes || !Object.keys(training.source_hashes).length
      || !Object.values(training.source_hashes).every(isHash)
      || payload.lineage?.type !== "weights-only-warm-start"
      || payload.lineage.parent_id !== training.parent_model_id
      || payload.lineage.parent_sha256 !== training.parent_model_sha256) {
    throw new Error("三人 AI 模型格式或后训练来源无效。");
  }
  const spec = structuredClone(payload);
  return {
    spec,
    score(features) {
      return features.reduce((sum, value, index) => sum + value * spec.weights[index], 0);
    },
  };
}

export async function loadThreePlayerModel(id = DEFAULT_THREE_PLAYER_MODEL_ID) {
  const asset = threePlayerModelAsset(id);
  if (id === "three-player-policy-v1") return loadV1Model(id);
  if (!promises.has(id)) {
    promises.set(id, (async () => {
      const response = await fetch(new URL(`./${asset}`, import.meta.url));
      if (!response.ok) throw new Error(`无法加载三人 AI 模型（HTTP ${response.status}）。`);
      const bytes = await response.arrayBuffer();
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      if (hash !== THREE_PLAYER_MODEL_HASHES[id]) throw new Error("三人 AI 模型校验失败，请刷新后重试。");
      const model = createSupportedThreePlayerModel(JSON.parse(new TextDecoder().decode(bytes)));
      if (model.spec.id !== id) throw new Error("三人 AI 模型身份不匹配。");
      return model;
    })().catch((error) => { promises.delete(id); throw error; }));
  }
  return promises.get(id);
}
