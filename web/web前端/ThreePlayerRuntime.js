import { loadThreePlayerModel, ThreePlayerAI } from "./ThreePlayerModels.js?v=20261025-ai1";
import { ThreePlayerSearchAI } from "./ThreePlayerSearchAI.js?v=20261025-ai1";
import { THREE_PLAYER_SEARCH_MODEL_ID, THREE_PLAYER_SEARCH_MODEL_SHA256, THREE_PLAYER_SEARCH_SIZES } from "./ThreePlayerSearchOptions.js?v=20261025-ai1";

let searchModelPromise;
export async function loadThreePlayerSearchModel(id = THREE_PLAYER_SEARCH_MODEL_ID) {
  if (id !== THREE_PLAYER_SEARCH_MODEL_ID) throw new Error(`未找到三人搜索 AI 模型：${id}`);
  if (!searchModelPromise) {
    searchModelPromise = (async () => {
      const response = await fetch(new URL(`./assets/research-ai/${id}.json`, import.meta.url));
      if (!response.ok) throw new Error(`无法加载三人搜索 AI 模型（HTTP ${response.status}）。`);
      const bytes = await response.arrayBuffer();
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      if (hash !== THREE_PLAYER_SEARCH_MODEL_SHA256) throw new Error("三人搜索 AI 模型校验失败，请刷新后重试。");
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      if (payload.id !== id) throw new Error("三人搜索 AI 模型身份不匹配。");
      // This validates the search schema. Lineage paths are provenance only;
      // the browser fetches only the relative, hash-pinned asset above.
      new ThreePlayerSearchAI(payload);
      return payload;
    })().catch((error) => { searchModelPromise = undefined; throw error; });
  }
  return structuredClone(await searchModelPromise);
}

export async function loadThreePlayerRuntime(modelId = "three-player-policy-v1", engine) {
  if (modelId === THREE_PLAYER_SEARCH_MODEL_ID) {
    if (engine.playerCount !== 3 || !["territory-v2", "territory-v3"].includes(engine.rulesVersion)
        || !THREE_PLAYER_SEARCH_SIZES.includes(engine.gridSize)) {
      throw new Error("三人搜索 AI 仅支持 territory-v2 的 5、7、9 路三人对局。");
    }
    const payload = await loadThreePlayerSearchModel(modelId);
    return { ai: new ThreePlayerSearchAI(payload), modelInfo: {
      id: payload.id, evidenceTier: "independently-verified-application-final-v4",
      evaluatedBoardSizes: [...THREE_PLAYER_SEARCH_SIZES],
      compatibility: "territory-v2 three-player; 5/7/9",
      inheritedModelId: "three-player-policy-v2", newGradientUpdates: 0,
      candidateSha256: THREE_PLAYER_SEARCH_MODEL_SHA256,
      search: { rootWidth: payload.search.rootWidth, rolloutPlies: payload.search.rolloutPlies },
    } };
  }
  // Honor explicit v1/v2 requests, including historical/replay fixtures. A
  // missing or invalid v4 asset never silently substitutes a different model.
  const model = await loadThreePlayerModel(modelId);
  return { ai: new ThreePlayerAI(model), modelInfo: {
    id: model.spec.id, evidenceTier: model.spec.training.evidence_tier,
    trainedBoardSizes: model.spec.training.trained_board_sizes,
    compatibility: "territory-v2 three-player",
  } };
}
