import { createHardRuntimeV2 } from "./MultiplayerHardRuntime.js?v=20261026-allplatform1";
import { threePlayerModelIdForBoard } from "./ThreePlayerSearchOptions.js?v=20261026-allplatform1";
import { trainedPolicySpec, trainedPolicyInfo } from "./PassTrainedPolicies.js?v=20261026-allplatform1";
import { multiplayerClock as performance } from "./MultiplayerClock.js";
import { portableClone } from "./PortableClone.js";

export const HARD_MODEL_ID = "multiplayer-hard-v1";
const defaultLoaders = Object.freeze({});
const preparedByLoaders = new WeakMap();

function preparedFor(loaders) {
  const key = loaders && typeof loaders === "object" ? loaders : defaultLoaders;
  let prepared = preparedByLoaders.get(key);
  if (!prepared) {
    prepared = new Map();
    preparedByLoaders.set(key, prepared);
  }
  return prepared;
}

export function supportsNativeHardContext(source) {
  return Boolean(source && [3, 4, 5, 6].includes(source.playerCount)
    && Number.isInteger(source.gridSize) && source.gridSize >= 5 && source.gridSize <= 15
    && source.boardShape === (source.playerCount === 3 ? "triangle" : "hexagon")
    && ["territory-v2", "territory-v3"].includes(source.rulesVersion));
}

export async function prepareHardResources(source, loaders = defaultLoaders) {
  if (!supportsNativeHardContext(source)) throw new Error("Unsupported native Hard AI configuration");
  const { playerCount, gridSize, boardShape, rulesVersion } = source;
  const context = { playerCount, gridSize, boardShape, rulesVersion };
  const prepared = preparedFor(loaders);
  const key = JSON.stringify(context), started = performance.now(), reused = prepared.has(key);
  if (!reused) {
    const promise = (async () => {
      if (playerCount === 3) {
        const loadThreePlayerRuntime = loaders.loadThreePlayerRuntime ?? (async (...args) =>
          (await import("./ThreePlayerRuntime.js?v=20261026-allplatform1")).loadThreePlayerRuntime(...args));
        const id = threePlayerModelIdForBoard(gridSize);
        const runtime = await loadThreePlayerRuntime(id, context);
        if (runtime.modelInfo.id !== id) throw new Error("Three-player resource identity changed");
        return { policySpec: runtime.ai.base ? runtime.ai.spec : runtime.ai.model.spec,
          modelInfo: { id: runtime.modelInfo.id } };
      }
      const loadHexPlayerModel = loaders.loadHexPlayerModel ?? (async (...args) =>
        (await import("./HexPlayerAI.js?v=20261026-allplatform1")).loadHexPlayerModel(...args));
      const parent = await loadHexPlayerModel();
      const model = { ...parent, spec: trainedPolicySpec(parent.spec, "hex-v1", rulesVersion) };
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
  return { medium: portableClone(await prepared.get(key)), context,
    resourceWaitMs: performance.now() - started, resourcePromiseReused: reused };
}

export async function loadNativeHardRuntime(engine, loaders = defaultLoaders) {
  const loaderEnteredMs = performance.now(), loaded = await prepareHardResources(engine, loaders);
  const started = performance.now(), runtime = createHardRuntimeV2(engine, loaded.medium);
  return { ai: runtime.ai, modelInfo: { ...runtime.modelInfo, id: HARD_MODEL_ID,
    ...trainedPolicyInfo(loaded.medium.policySpec),
    runtime_uses_learned_pass: false,
    runtime_uses_trained_placement: Boolean(loaded.medium.policySpec.passDisciplineTraining),
    runtime_policy: "original-native-hard-search-with-trained-placement-base-and-shared-PASS-guard",
    compatibility: `${engine.rulesVersion} native 3–6 players; size 5–15`,
    startup: { loaderEnteredMs, resourceWaitMs: loaded.resourceWaitMs,
      resourcePromiseReused: loaded.resourcePromiseReused, factoryMs: performance.now() - started,
      mediumPolicyId: loaded.medium.modelInfo.id, implementation: "native-hard-minimal-resources-v1" } } };
}
