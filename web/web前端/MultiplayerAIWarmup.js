// Resource-only prewarming for active local multiplayer matches.
const MODEL_IDS = new Set(["multiplayer-easy-v1", "multiplayer-medium-v1", "multiplayer-hard-v1", "multiplayer-ultimate-v1"]);
const contextOf = value => {
  if (!value || !Number.isInteger(value.playerCount) || value.playerCount < 3 || value.playerCount > 6
      || !Number.isInteger(value.gridSize) || value.gridSize < 5 || value.gridSize > 15
      || !["triangle", "hexagon"].includes(value.boardShape) || !["territory-v2", "territory-v3"].includes(value.rulesVersion)) return null;
  return { playerCount: value.playerCount, gridSize: value.gridSize, boardShape: value.boardShape, rulesVersion: value.rulesVersion };
};
const supported = profile => profile?.strategy === "multiplayer" && MODEL_IDS.has(profile.modelId);
const identity = (modelId, context) => JSON.stringify([modelId, context.playerCount, context.gridSize, context.boardShape, context.rulesVersion]);

export class MultiplayerWarmupSession {
  constructor() { this.sent = new WeakMap(); }
  hasRequested(worker) { return this.sent.has(worker); }
  request({ started, allowed, humanTurn, idle, context: sourceContext, profiles, ensureWorker } = {}) {
    if (!started || !allowed || !humanTurn || !idle) return 0;
    const context = contextOf(sourceContext);
    if (!context || !Array.isArray(profiles) || typeof ensureWorker !== "function") return 0;
    const modelIds = [...new Set(profiles.filter(supported).map(profile => profile.modelId))];
    if (!modelIds.length) return 0;
    // Speculative startup cannot pause a match or replace its normal error path.
    let worker;
    try { worker = ensureWorker(); } catch (_) { return 0; }
    if (!worker || typeof worker.postMessage !== "function") return 0;
    let sent = this.sent.get(worker);
    if (!sent) { sent = new Set(); this.sent.set(worker, sent); }
    let count = 0;
    for (const modelId of modelIds) {
      const key = identity(modelId, context);
      if (sent.has(key)) continue;
      try {
        worker.postMessage({ type: "WARMUP", strategy: "multiplayer", modelId, context });
        sent.add(key); count++;
      } catch (_) { /* A later formal request retains its existing recovery path. */ }
    }
    return count;
  }
}

export function createMultiplayerWarmupLoader(importRuntime = () => import("./MultiplayerRuntime.js?v=20261025-unified1")) {
  const pending = new Map();
  return message => {
    const context = contextOf(message?.context);
    if (message?.type !== "WARMUP" || !supported(message) || !context) return Promise.resolve(false);
    const key = identity(message.modelId, context);
    if (pending.has(key)) return pending.get(key);
    const promise = Promise.resolve().then(importRuntime).then(async ({ loadMultiplayerRuntime }) => {
      // All current multiplayer loaders use only these four context fields.
      // Discard the runtime object: COMPUTE must construct its own fresh state
      // and AI instance, and must repeat its normal model identity validation.
      const runtime = await loadMultiplayerRuntime(message.modelId, context);
      if (runtime?.modelInfo?.id !== message.modelId) throw new Error("Multiplayer warmup model identity mismatch");
      return true;
    }).catch(error => {
      if (pending.get(key) === promise) pending.delete(key);
      throw error;
    });
    pending.set(key, promise);
    return promise;
  };
}
export const warmMultiplayerResources = createMultiplayerWarmupLoader();
