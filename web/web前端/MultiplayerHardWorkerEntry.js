// Bundled together with the unchanged current AIWorker. Explicit queuing also
// handles messages delivered before its asynchronous module installs onmessage.
import { HARD_MODEL_ID, prepareHardResources, supportsNativeHardContext } from "./MultiplayerHardResources.js?v=20261025-unified1";
export { prepareHardResources, loadNativeHardRuntime } from "./MultiplayerHardResources.js?v=20261025-unified1";
export { loadMultiplayerRuntime } from "./MultiplayerHardWorkerRuntime.js?v=20261025-unified1";
const pending = [], requests = new Map();
const post = self.postMessage.bind(self), bootstrapEnteredMs = performance.now();
let originalHandler = null;

function forward(event) {
  const request = requests.get(event.data?.requestId);
  if (request && event.data?.type === "COMPUTE") {
    request.formalDispatchCount++;
    request.formalDispatchMs = performance.now();
  }
  return originalHandler.call(self, event);
}

self.addEventListener("message", event => {
  event.stopImmediatePropagation();
  const message = event.data;
  if (message?.type === "COMPUTE") {
    const request = { queuedBeforeHandler: originalHandler === null, formalDispatchCount: 0,
      requestReceivedMs: performance.now(), formalDispatchMs: null };
    requests.set(message.requestId, request);
    if (message.strategy === "multiplayer" && message.modelId === HARD_MODEL_ID
        && supportsNativeHardContext(message.serializedState)) {
      // Speculative errors are still delivered by AIWorker's formal load path.
      prepareHardResources(message.serializedState).catch(() => {});
    }
  }
  if (originalHandler) forward(event);
  else pending.push(event);
});

self.postMessage = (message, ...rest) => {
  const request = requests.get(message?.requestId);
  if (!request || !["READY", "RESULT", "ERROR"].includes(message?.type)) return post(message, ...rest);
  const startupStats = { ...request, bootstrapEnteredMs, implementation: "application-single-file-hard-v1" };
  if (message.type !== "READY") requests.delete(message.requestId);
  return post({ ...message, startupStats }, ...rest);
};

await import("./AIWorker.js?v=20261025-unified1");
originalHandler = self.onmessage;
if (typeof originalHandler !== "function") throw new Error("AIWorker message handler was not installed");
self.onmessage = null;
for (const event of pending.splice(0)) forward(event);
