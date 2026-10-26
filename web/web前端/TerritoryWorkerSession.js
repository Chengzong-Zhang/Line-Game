import {
  captureWorkerRequest,
  isWorkerResultForRequest,
} from "./AIStateProtocol.js?v=20261026-start-protection-v1";

function noop() {}

function normalizeError(error) {
  if (error instanceof Error) {
    return error;
  }
  if (error?.message) {
    return new Error(String(error.message));
  }
  return new Error(String(error ?? "Territory worker failed."));
}

/** Apply a Worker result only through GameEngine's revision-checked cache API. */
export function applyTerritoryWorkerResult({
  engine,
  territories,
  territoryStateRevision,
}) {
  if (!engine || typeof engine.applyTerritoryCache !== "function") {
    return false;
  }
  return engine.applyTerritoryCache(territories, territoryStateRevision);
}

/**
 * One exact territory calculation at a time.  It deliberately mirrors the
 * hint worker's identity/revision guard so a late score can never overwrite a
 * reset, recovered, or subsequently played position.
 */
export class OneShotTerritoryWorker {
  constructor(createWorker) {
    if (typeof createWorker !== "function") {
      throw new TypeError("OneShotTerritoryWorker requires a worker factory.");
    }
    this.createWorker = createWorker;
    this.requestSequence = 0;
    this.active = null;
  }

  get activeRequestId() {
    return this.active?.request.requestId ?? null;
  }

  _settle(active, status, payload = null) {
    if (this.active !== active) {
      return false;
    }

    this.active = null;
    active.worker.onmessage = null;
    active.worker.onerror = null;
    active.worker.terminate();

    try {
      if (status === "result") {
        active.onResult(payload);
      } else if (status === "error") {
        active.onError(normalizeError(payload));
      }
    } finally {
      active.onFinish({
        status,
        requestId: active.request.requestId,
      });
    }
    return true;
  }

  cancel() {
    if (!this.active) {
      return false;
    }
    return this._settle(this.active, "cancelled");
  }

  start({
    engine,
    getCurrentEngine = () => engine,
    message = {},
    onResult = noop,
    onError = noop,
    onFinish = noop,
  }) {
    if (!engine) {
      throw new Error("OneShotTerritoryWorker.start requires a source engine.");
    }
    if (typeof getCurrentEngine !== "function") {
      throw new TypeError("getCurrentEngine must be a function.");
    }
    if (typeof engine.getTerritoryStateRevision !== "function") {
      throw new TypeError("OneShotTerritoryWorker requires a revision-aware GameEngine.");
    }

    this.cancel();
    const worker = this.createWorker();
    const requestId = ++this.requestSequence;
    const request = captureWorkerRequest(engine, requestId);
    const active = {
      worker,
      request: {
        ...request,
        territoryStateRevision: engine.getTerritoryStateRevision(),
        gameOver: Boolean(engine.gameOver),
      },
      getCurrentEngine,
      onResult,
      onError,
      onFinish,
    };
    this.active = active;

    worker.onmessage = (event) => {
      if (this.active !== active) {
        return;
      }

      const response = event?.data;
      if (response?.requestId !== requestId) {
        this._settle(
          active,
          "error",
          new Error("Territory worker returned a mismatched requestId."),
        );
        return;
      }
      if (response.type !== "RESULT" && response.type !== "ERROR") {
        this._settle(active, "error", new Error("Territory worker returned an invalid response."));
        return;
      }

      const currentEngine = active.getCurrentEngine();
      const responseMatchesRequest = response.territoryStateRevision === active.request.territoryStateRevision
        && response.gameOver === active.request.gameOver;
      const currentMatchesRequest = currentEngine === engine
        && currentEngine?.getTerritoryStateRevision?.() === active.request.territoryStateRevision
        && Boolean(currentEngine?.gameOver) === active.request.gameOver;
      if (
        !responseMatchesRequest
        || !currentMatchesRequest
        || !isWorkerResultForRequest(currentEngine, active.request, response)
      ) {
        this._settle(active, "stale", response);
        return;
      }
      if (response.type === "ERROR") {
        this._settle(active, "error", new Error(response.message ?? "Territory worker failed."));
        return;
      }
      this._settle(active, "result", response);
    };

    worker.onerror = (event) => {
      if (this.active === active) {
        this._settle(active, "error", event);
      }
    };

    try {
      worker.postMessage({
        ...message,
        requestId,
        territoryStateRevision: active.request.territoryStateRevision,
        gameOver: active.request.gameOver,
      });
    } catch (error) {
      this._settle(active, "error", error);
    }

    return requestId;
  }
}

export default OneShotTerritoryWorker;
