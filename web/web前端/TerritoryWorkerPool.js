import { captureWorkerRequest, isWorkerResultForRequest } from "./AIStateProtocol.js?v=20261025-room1";

const noop = () => {};

function matches(engine, request) {
  return engine === request.engine
    && engine?.positionRevision === request.positionRevision
    && engine?.rulesVersion === request.rulesVersion
    && engine?.currentPlayer === request.currentPlayer
    && engine?.getTerritoryStateRevision() === request.territoryStateRevision
    && Boolean(engine?.gameOver) === request.gameOver;
}

function validTerritory(engine, territory) {
  return territory && Number.isInteger(territory.area) && territory.area >= 0
    && Number.isFinite(territory.displayArea)
    && (territory.polygon === null || (Array.isArray(territory.polygon)
      && territory.polygon.length >= 3
      && territory.polygon.every(point => Array.isArray(point) && point.length === 2
        && engine.isValidPosition(point))));
}

/** Warm, bounded pool. Each job calls the unchanged exact scorer for one seat.
 * Busy jobs finish; only the latest position is queued. Repeated UI syncs never
 * restart a calculation. Completed seats may paint before the slowest seat,
 * but scores are committed only after the entire current position is ready.
 */
export class TerritoryWorkerPool {
  constructor(createWorker, { size = 3, timeoutMs = 60000 } = {}) {
    this.createWorker = createWorker;
    this.size = Math.max(1, Math.min(3, Math.floor(size) || 1));
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.active = null;
    this.engine = null;
    this.slots = [];
  }

  get activeRequestId() { return this.active?.request.requestId ?? null; }

  hasCurrentRequest(engine) {
    return Boolean(this.active && matches(engine, this.active.request));
  }

  cancelPending(status = "cancelled") {
    const active = this.active;
    this.active = null;
    active?.onFinish({ status, requestId: active.request.requestId });
    return Boolean(active);
  }

  cancel() {
    const cancelled = this.cancelPending();
    for (const slot of this.slots) this._dispose(slot);
    this.slots = [];
    this.engine = null;
    return cancelled;
  }

  _dispose(slot) {
    clearTimeout(slot.timer);
    slot.worker.onmessage = null;
    slot.worker.onerror = null;
    slot.worker.terminate();
    slot.job = null;
  }

  start({ engine, getCurrentEngine = () => engine, message,
    onProgress = noop, onResult = noop, onError = noop, onFinish = noop }) {
    if (!engine || !message?.serializedState) throw new Error("Territory pool requires a serialized engine.");
    if (this.hasCurrentRequest(engine)) return this.active.request.requestId;
    if (this.engine && this.engine !== engine) this.cancel();
    else this.cancelPending();
    this.engine = engine;
    const requestId = ++this.sequence;
    this.active = {
      request: { ...captureWorkerRequest(engine, requestId),
        territoryStateRevision: engine.getTerritoryStateRevision(), gameOver: Boolean(engine.gameOver) },
      getCurrentEngine, message, onProgress, onResult, onError, onFinish,
      queued: [...engine.activePlayers], territories: {},
    };
    this._pump();
    return requestId;
  }

  _fail(slot, error) {
    const job = slot.job;
    this._dispose(slot);
    this.slots = this.slots.filter(candidate => candidate !== slot);
    if (job?.active === this.active) {
      const active = this.active;
      this.active = null;
      this.cancel();
      try { active.onError(error instanceof Error ? error : new Error(error?.message ?? String(error))); }
      finally { active.onFinish({ status: "error", requestId: active.request.requestId }); }
    } else this._pump();
  }

  _receive(slot, response) {
    const job = slot.job;
    if (!job) return;
    // A duplicate from a completed job must not cancel the next job on a warm
    // worker. A genuinely missing/malformed reply is handled by its timeout.
    if (response?.requestId !== job.id) return;
    clearTimeout(slot.timer);
    slot.job = null;
    const active = this.active;
    if (job.active !== active || !matches(active.getCurrentEngine(), active.request)) {
      // A newer board takes the next available slot; never paint the old one.
      if (job.active === active) this.cancelPending("stale");
      this._pump();
      return;
    }
    const request = { ...active.request, requestId: job.id };
    if (!isWorkerResultForRequest(active.getCurrentEngine(), request, response)
      || response.territoryStateRevision !== request.territoryStateRevision
      || response.gameOver !== request.gameOver
      || !["RESULT", "ERROR"].includes(response.type)) {
      slot.job = job;
      this._fail(slot, new Error("Territory worker returned a mismatched response."));
      return;
    }
    if (response.type === "ERROR" || !validTerritory(request.engine, response.territories?.[job.player])) {
      slot.job = job;
      this._fail(slot, new Error(response.message ?? "Territory worker returned invalid geometry."));
      return;
    }
    active.territories[job.player] = response.territories[job.player];
    const result = { ...response, requestId: request.requestId,
      territories: { ...active.territories } };
    if (Object.keys(active.territories).length === request.engine.activePlayers.length) {
      this.active = null;
      active.onResult(result);
      active.onFinish({ status: "result", requestId: request.requestId });
    } else active.onProgress(result);
    this._pump();
  }

  _pump() {
    const active = this.active;
    if (!active || !matches(active.getCurrentEngine(), active.request)) return;
    while (active.queued.length) {
      let slot = this.slots.find(candidate => !candidate.job);
      if (!slot) {
        const limit = Math.min(this.size, active.request.engine.activePlayers.length);
        if (this.slots.length >= limit) break;
        try {
          slot = { worker: this.createWorker(), job: null, timer: null };
        } catch (error) {
          this.active = null;
          this.cancel();
          try { active.onError(error); }
          finally { active.onFinish({ status: "error", requestId: active.request.requestId }); }
          return;
        }
        this.slots.push(slot);
        slot.worker.onmessage = event => this._receive(slot, event.data);
        slot.worker.onerror = error => this._fail(slot, error);
      }
      const player = active.queued.shift();
      const id = `${active.request.requestId}:${player}`;
      slot.job = { active, player, id };
      if (this.timeoutMs > 0) {
        slot.timer = setTimeout(() => this._fail(slot, new Error("Territory worker timed out.")), this.timeoutMs);
      }
      try {
        slot.worker.postMessage({ ...active.message, players: [player], requestId: id,
          territoryStateRevision: active.request.territoryStateRevision, gameOver: active.request.gameOver });
      } catch (error) {
        this._fail(slot, error);
        return;
      }
    }
  }
}

export default TerritoryWorkerPool;
