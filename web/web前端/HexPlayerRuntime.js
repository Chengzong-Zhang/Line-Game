import { HEX_PLAYER_MODEL_ID, HexPlayerAI, loadHexPlayerModel } from "./HexPlayerAI.js?v=20261025-unified1";
import { HexFastSearchAI } from "./HexFastSearchAI.js?v=20261025-unified1";
import { HEX_SEARCH_MODEL_ID, HEX_SEARCH_MODEL_SHA256, HEX_SEARCH_SIZES, HEX_SEARCH_PLAYER_COUNTS } from "./HexSearchOptions.js?v=20261025-unified1";

// Workers may explicitly request this candidate; default selection remains v1.
let candidatePromise;
export async function loadHexSearchCandidate(modelId = HEX_SEARCH_MODEL_ID) {
  if (modelId !== HEX_SEARCH_MODEL_ID) throw new Error(`未找到六边形搜索 AI 模型：${modelId}`);
  if (!candidatePromise) {
    candidatePromise = (async () => {
      const response = await fetch(new URL(`./assets/research-ai/${HEX_SEARCH_MODEL_ID}.json`, import.meta.url));
      if (!response.ok) throw new Error(`无法加载六边形搜索 AI 模型（HTTP ${response.status}）。`);
      const bytes = await response.arrayBuffer();
      if (!globalThis.crypto?.subtle) throw new Error("无法校验六边形搜索 AI 模型完整性。");
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      if (hash !== HEX_SEARCH_MODEL_SHA256) throw new Error("六边形搜索 AI 模型完整性校验失败，请刷新后重试。");
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      if (payload.id !== modelId) throw new Error("六边形搜索 AI 模型身份不匹配。");
      new HexFastSearchAI(payload);
      return payload;
    })().catch((error) => { candidatePromise = undefined; throw error; });
  }
  return structuredClone(await candidatePromise);
}

function requireHexContext(engine, searchOnly = false) {
  if (!engine || engine.boardShape !== "hexagon" || !HEX_SEARCH_PLAYER_COUNTS.includes(engine.playerCount) || !["territory-v2", "territory-v3"].includes(engine.rulesVersion)
      || !Number.isInteger(engine.gridSize) || engine.gridSize < 5 || engine.gridSize > 15) {
    throw new Error("六边形 AI 需要六边形棋盘、边长 5–15、4–6 人的 territory-v2 对局。");
  }
  if (searchOnly && !HEX_SEARCH_SIZES.includes(engine.gridSize)) {
    throw new Error("六边形搜索 AI 候选仅支持 5、7 路；请明确选择当前尺寸的 v1 模型。");
  }
}

export async function loadHexPlayerRuntime(modelId = HEX_PLAYER_MODEL_ID, engine) {
  if (modelId === HEX_SEARCH_MODEL_ID) {
    requireHexContext(engine, true);
    const payload = await loadHexSearchCandidate(modelId);
    return { ai: new HexFastSearchAI(payload), modelInfo: {
      id: payload.id, evidenceTier: "unpromoted-search-candidate",
      runtimeBoardSizes: [...HEX_SEARCH_SIZES], playerCounts: [...HEX_SEARCH_PLAYER_COUNTS],
      compatibility: "territory-v2 hexagon 4–6 players; 5/7; candidate only",
      inheritedModelId: payload.parent.id, newGradientUpdates: 0,
      candidateSha256: HEX_SEARCH_MODEL_SHA256,
      search: { rootWidth: payload.search.rootWidth, maxResponsePlies: payload.search.maxResponsePlies },
    } };
  }
  if (modelId !== HEX_PLAYER_MODEL_ID) throw new Error(`未找到六边形 AI 模型：${modelId}`);
  requireHexContext(engine);
  const model = await loadHexPlayerModel(modelId);
  return { ai: new HexPlayerAI(model), modelInfo: {
    id: model.spec.id, evidenceTier: model.spec.training.evidence_tier,
    trainedBoardSizes: model.spec.training.trained_board_sizes,
    compatibility: "territory-v2 hexagon 4–6 players; 5–15",
  } };
}
