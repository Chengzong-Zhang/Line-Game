// Node adapter for the same model loaders and AI implementations used by the
// browser Worker. Only model asset file: URLs gain a local fetch implementation.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative, isAbsolute, sep } from "node:path";
import { webcrypto } from "node:crypto";
import { GreedyAI, MinimaxAI } from "../web前端/AIEngine.js?v=20261025-room1";
import { createUltimateAdmissionGuard } from "../web前端/MultiplayerUltimateAdmission.js?v=20261025-room1";
import { applyPassDiscipline } from "../web前端/AIPassDisciplineV4.js";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;
const assetRoot = fileURLToPath(new URL("../web前端/assets/research-ai/", import.meta.url));
const fetchMarker = Symbol.for("lifeline.node-model-asset-fetch");

export function installLocalModelAssetFetch() {
  if (globalThis.fetch?.[fetchMarker]) return;
  const original = globalThis.fetch;
  const localFetch = async (input, options) => {
    let url;
    try { url = new URL(input instanceof Request ? input.url : input); } catch (_) { return original(input, options); }
    if (url.protocol !== "file:") return original(input, options);
    const target = fileURLToPath(url), path = relative(assetRoot, target);
    if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error("MODEL_ASSET_OUTSIDE_ROOT");
    if (options?.method && options.method !== "GET") throw new Error("MODEL_ASSET_READ_ONLY");
    try {
      const bytes = await readFile(target);
      return new Response(bytes, { status: 200, headers: { "content-type": target.endsWith(".json") ? "application/json" : "application/octet-stream" } });
    } catch (error) {
      if (error?.code === "ENOENT") return new Response(null, { status: 404 });
      throw error;
    }
  };
  Object.defineProperty(localFetch, fetchMarker, { value: true });
  globalThis.fetch = localFetch;
}

export async function createRoomBotRuntime(engine, profile) {
  if (!profile) throw new Error("HUMAN_SEAT_HAS_NO_AI");
  const nativeShape = engine.playerCount >= 4 ? "hexagon" : "triangle";
  if (engine.boardShape !== nativeShape && !["greedy", "minimax", "multiplayer"].includes(profile.strategy)) {
    throw new Error("MODEL_UNSUPPORTED_BOARD_SHAPE");
  }
  installLocalModelAssetFetch();
  if (profile.strategy === "greedy") return { ai: new GreedyAI(), modelInfo: { strategy: "greedy" } };
  if (profile.strategy === "minimax") return {
    ai: new MinimaxAI(profile.depth, { iterativeDeepening: profile.depth >= 4 }),
    modelInfo: { strategy: "minimax", depth: profile.depth },
  };
  if (profile.strategy === "multiplayer") {
    const admission = createUltimateAdmissionGuard().checkProfile(profile, engine);
    if (!admission.allowed) { const error = new Error(admission.message); error.code = admission.code; throw error; }
    const { loadMultiplayerRuntime } = await import("../web前端/MultiplayerRuntime.js?v=20261025-room1");
    const runtime = await loadMultiplayerRuntime(profile.modelId, engine);
    if (runtime.modelInfo?.id !== profile.modelId) throw new Error("MULTIPLAYER_MODEL_IDENTITY_MISMATCH");
    return runtime;
  }
  if (profile.strategy === "three-player") {
    const { loadThreePlayerRuntime } = await import("../web前端/ThreePlayerRuntime.js?v=20261025-room1");
    return loadThreePlayerRuntime(profile.modelId, engine);
  }
  if (profile.strategy === "hex-player") {
    const { loadHexPlayerRuntime } = await import("../web前端/HexPlayerRuntime.js?v=20261025-room1");
    return loadHexPlayerRuntime(profile.modelId, engine);
  }
  if (profile.strategy === "neural-puct") {
    const { loadResearchModel, NeuralPUCTAI, supportsResearchInference } = await import("../web前端/ResearchAI.js?v=20261025-room1");
    const model = await loadResearchModel(profile.modelId);
    if (!supportsResearchInference(model.spec, engine)) throw new Error("MODEL_UNSUPPORTED_CONTEXT");
    return { ai: new NeuralPUCTAI(model, { simulations: profile.simulations, cPuct: profile.cPuct }),
      modelInfo: { id: model.spec.id, strategy: profile.strategy, evidenceTier: model.spec.evidence_tier ?? "legacy" } };
  }
  if (profile.strategy === "model-free") {
    if (engine.playerCount !== 2) throw new Error("MODEL_UNSUPPORTED_CONTEXT");
    const { loadModelFreeModel, ModelFreeAI } = await import("../web前端/ModelFreeAI.js?v=20261025-room1");
    const model = await loadModelFreeModel(profile.modelId);
    return { ai: new ModelFreeAI(model), modelInfo: { id: model.spec.id, strategy: profile.strategy } };
  }
  throw new Error(`UNSUPPORTED_AI_STRATEGY:${profile.strategy}`);
}

export async function chooseRoomBotMove(engine, profile) {
  const { ai, modelInfo } = await createRoomBotRuntime(engine, profile);
  const ranked = ai.getTopMoves(engine, engine.currentPlayer, 5, { passDisciplinePrechecked: true });
  const disciplined = applyPassDiscipline(engine, ranked, { player: engine.currentPlayer, topN: 1 });
  const move = disciplined.moves[0];
  if (!move) {
    if (engine.getLegalMoves().length) throw new Error("AI_RETURNED_NO_DECISION");
    return { point: null, modelInfo };
  }
  if (move.point == null && move.type !== "pass") throw new Error("AI_RETURNED_INVALID_DECISION");
  return { point: move.point, modelInfo, searchStats: { ...(ai.lastSearch || {}), passDiscipline: disciplined.receipt } };
}
