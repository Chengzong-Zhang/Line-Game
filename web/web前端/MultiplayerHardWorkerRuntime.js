// The bundle resolves AIWorker/Warmup runtime imports to this adapter. The
// general runtime remains external and is loaded only for another exact ID.
import { HARD_MODEL_ID, supportsNativeHardContext, loadNativeHardRuntime } from "./MultiplayerHardResources.js?v=20261025-room1";

export async function loadMultiplayerRuntime(modelId, engine) {
  if (modelId === HARD_MODEL_ID && supportsNativeHardContext(engine)) return loadNativeHardRuntime(engine);
  const general = await import("./MultiplayerRuntime.js?v=20261025-room1");
  return general.loadMultiplayerRuntime(modelId, engine);
}
