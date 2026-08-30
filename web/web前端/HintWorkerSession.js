import {
  captureWorkerRequest,
  isWorkerResultForRequest,
} from "./AIStateProtocol.js?v=20260830a";

function noop() {}

function normalizeError(error) {
  if (error instanceof Error) {
    return error;
  }
  if (error?.message) {
    return new Error(String(error.message));
  }
  return new Error(String(error ?? "Hint worker failed."));
}

function isGridPoint(point) {
  return Array.isArray(point)
    && point.length === 2
    && Number.isInteger(point[0])
    && Number.isInteger(point[1]);
}

function samePoint(left, right) {
  return left[0] === right[0] && left[1] === right[1];
}

export function applyHintWorkerResult({
  moves,
  legalMoves,
  remainingCount,
  renderHint,
}) {
  const point = moves?.[0]?.point;
  if (!isGridPoint(point)) {
    return { applied: false, reason: "NO_MOVE", nextRemainingCount: remainingCount };
  }

  const legal = Array.isArray(legalMoves)
    && legalMoves.some((move) => {
      const legalPoint = Array.isArray(move) ? move : move?.point;
      return isGridPoint(legalPoint) && samePoint(legalPoint, point);
    });
  if (!legal) {
    return { applied: false, reason: "ILLEGAL_MOVE", nextRemainingCount: remainingCount };
  }
  if (!Number.isFinite(remainingCount) || remainingCount <= 0) {
    return { applied: false, reason: "EXHAUSTED", nextRemainingCount: remainingCount };
  }
  if (typeof renderHint !== "function") {
    throw new TypeError("renderHint must be a function.");
  }

  const renderedPoint = [...point];
  renderHint(renderedPoint);
  return {
    applied: true,
    reason: null,
    point: renderedPoint,
    nextRemainingCount: Math.max(0, remainingCount - 1),
  };
}

export class OneShotHintWorker {
  constructor(createWorker) {
    if (typeof createWorker !== "function") {
      throw new TypeError("OneShotHintWorker requires a worker factory.");
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
      throw new Error("OneShotHintWorker.start requires a source engine.");
    }
    if (typeof getCurrentEngine !== "function") {
      throw new TypeError("getCurrentEngine must be a function.");
    }

    this.cancel();
    const worker = this.createWorker();
    const requestId = ++this.requestSequence;
    const active = {
      worker,
      request: captureWorkerRequest(engine, requestId),
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
          new Error("Hint worker returned a mismatched requestId."),
        );
        return;
      }
      if (response.type !== "RESULT" && response.type !== "ERROR") {
        this._settle(active, "error", new Error("Hint worker returned an invalid response."));
        return;
      }
      if (!isWorkerResultForRequest(active.getCurrentEngine(), active.request, response)) {
        this._settle(active, "stale", response);
        return;
      }
      if (response.type === "ERROR") {
        this._settle(active, "error", new Error(response.message ?? "Hint worker failed."));
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
      });
    } catch (error) {
      this._settle(active, "error", error);
    }

    return requestId;
  }
}

export default OneShotHintWorker;
