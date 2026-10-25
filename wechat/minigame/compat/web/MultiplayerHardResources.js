import { multiplayerClock as performance } from "./MultiplayerClock.js";
import { portableClone as structuredClone } from './PortableClone.js';
import { createHardRuntimeV2 } from "./MultiplayerHardRuntime.js?v=20261023-hard2";
import { threePlayerModelIdForBoard } from "./ThreePlayerSearchOptions.js";

export const HARD_MODEL_ID = "multiplayer-hard-v1";
const prepared = new Map();

export function supportsNativeHardContext(source) {
  return Boolean(source && [3, 4, 5, 6].includes(source.playerCount)
    && Number.isInteger(source.gridSize) && source.gridSize >= 5 && source.gridSize <= 15
    && source.boardShape === (source.playerCount === 3 ? "triangle" : "hexagon")
    && ["territory-v2", "territory-v3"].includes(source.rulesVersion));
}

export async function prepareHardResources(source) {
  if (!supportsNativeHardContext(source)) throw new Error("Unsupported native Hard AI configuration");
  const { playerCount, gridSize, boardShape, rulesVersion } = source;
  const context = { playerCount, gridSize, boardShape, rulesVersion };
  const key = JSON.stringify(context), started = performance.now(), reused = prepared.has(key);
  if (!reused) {
    const promise = (async () => {
      if (playerCount === 3) {
        const { loadThreePlayerRuntime } = await import("./ThreePlayerRuntime.js");
        const id = threePlayerModelIdForBoard(gridSize);
        const runtime = await loadThreePlayerRuntime(id, context);
        if (runtime.modelInfo.id !== id) throw new Error("Three-player resource identity changed");
        return { policySpec: runtime.ai.base ? runtime.ai.spec : runtime.ai.model.spec,
          modelInfo: { id: runtime.modelInfo.id } };
      }
      const { loadHexPlayerModel } = await import("./HexPlayerAI.js");
      const model = await loadHexPlayerModel();
      if (model.spec.id !== "hex-player-policy-v1") throw new Error("Hex resource identity changed");
      return { policySpec: model.spec, modelInfo: { id: model.spec.id } };
    })().catch(error => {
      if (prepared.get(key) === promise) prepared.delete(key);
      throw error;
    });
    prepared.set(key, promise);
  }
  // Only parameter-loading promises are shared. A computation never receives
  // another request's mutable policy data, engine or fallback/search instance.
  return { medium: structuredClone(await prepared.get(key)), context,
    resourceWaitMs: performance.now() - started, resourcePromiseReused: reused };
}

export async function loadNativeHardRuntime(engine) {
  const loaderEnteredMs = performance.now(), loaded = await prepareHardResources(engine);
  const started = performance.now(), runtime = createHardRuntimeV2(engine, loaded.medium);
  return { ai: runtime.ai, modelInfo: { ...runtime.modelInfo, id: HARD_MODEL_ID,
    compatibility: `${engine.rulesVersion} native 3–6 players; size 5–15`,
    startup: { loaderEnteredMs, resourceWaitMs: loaded.resourceWaitMs,
      resourcePromiseReused: loaded.resourcePromiseReused, factoryMs: performance.now() - started,
      mediumPolicyId: loaded.medium.modelInfo.id, implementation: "native-hard-minimal-resources-v1" } } };
}
