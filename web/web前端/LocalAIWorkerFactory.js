// Select once from the active match, not the current seat or unsaved setup.
// All mixed seats keep one compatible Worker until the session cancels it.
const ordinaryUrl = new URL("./AIWorker.js?v=20261025-room1", import.meta.url);
const hardUrl = new URL("./MultiplayerHardAIWorker.bundle.mjs?v=20261025-room1", import.meta.url);

export function localAIWorkerRoute(context, profiles = []) {
  const native = context && [3, 4, 5, 6].includes(context.playerCount)
    && Number.isInteger(context.gridSize) && context.gridSize >= 5 && context.gridSize <= 15
    && context.boardShape === (context.playerCount === 3 ? "triangle" : "hexagon")
    && ["territory-v2", "territory-v3"].includes(context.rulesVersion);
  const activeProfiles = Array.isArray(profiles) ? profiles.slice(0, context?.playerCount ?? 0) : [];
  // The rebuilt bundle supports both territory-v2 and territory-v3.
  const hard = native && activeProfiles.some(profile => profile?.strategy === "multiplayer"
    && profile.modelId === "multiplayer-hard-v1");
  return { kind: hard ? "native-hard-bundle" : "ordinary", url: new URL(hard ? hardUrl : ordinaryUrl),
    identity: JSON.stringify([context?.playerCount, context?.gridSize, context?.boardShape, context?.rulesVersion, activeProfiles]) };
}

export function createLocalAIWorker(context, profiles, WorkerType = globalThis.Worker) {
  if (typeof WorkerType !== "function") throw new Error("Web Workers are unavailable");
  return new WorkerType(localAIWorkerRoute(context, profiles).url, { type: "module" });
}
