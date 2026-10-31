export const MOVE_HAPTICS_STORAGE_KEY = 'triaxis-haptics-on-move-v1';
const DEFAULT_TIMEOUT_MS = 750;
const NO_HOST = Symbol('no-haptics-host');
const NOT_DISPATCHED = Symbol('not-dispatched');

function readPreference(storage) {
  try {
    const value = storage?.getItem(MOVE_HAPTICS_STORAGE_KEY);
    return {
      enabled: value === '1',
      state: value === null || value === undefined || value === '0' ? 'ready' : value === '1' ? 'ready' : 'corrupt',
    };
  } catch (_error) {
    return { enabled: false, state: 'read-error' };
  }
}

function normalizeNativeStatus(value) {
  if (value?.status === 'requested') return 'requested';
  if (value?.status === 'suppressed') return 'suppressed';
  return 'unavailable';
}

export function createMoveHapticsController({
  storage,
  requestMoveHaptic,
  isActive = () => true,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  setTimeoutFn = globalThis.setTimeout.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout.bind(globalThis),
  onOutcome = null,
} = {}) {
  const preference = readPreference(storage);
  let enabled = preference.enabled;
  let active = true;
  let disposed = false;
  let generation = 0;
  let sequence = 0;
  let host = NO_HOST;
  let inFlight = null;

  const invalidate = () => {
    generation += 1;
    const pending = inFlight;
    if (!pending) return;
    if (pending.timer !== null) clearTimeoutFn(pending.timer);
    pending.timer = null;
    pending.stale = true;
    pending.resolve('stale');
    if (!pending.dispatched) inFlight = null;
  };

  const notify = (result, requestGeneration) => {
    if (requestGeneration !== generation || !enabled || !active || disposed) return;
    try { onOutcome?.(result); } catch (_error) {}
  };

  const finishNative = (pending, result) => {
    if (inFlight !== pending) return;
    inFlight = null;
    if (pending.timer !== null) clearTimeoutFn(pending.timer);
    if (pending.stale || pending.timedOut || pending.generation !== generation || disposed || !enabled || !active) return;
    pending.resolve(result);
    notify(result, pending.generation);
  };

  return {
    get enabled() { return enabled; },
    get preferenceState() { return preference.state; },

    setEnabled(nextEnabled) {
      const next = nextEnabled === true;
      if (!next) {
        enabled = false;
        invalidate();
        try {
          if (!storage || typeof storage.setItem !== 'function') throw new Error('Storage is unavailable.');
          storage.setItem(MOVE_HAPTICS_STORAGE_KEY, '0');
          return { enabled: false, persisted: true };
        } catch (_error) {
          return { enabled: false, persisted: false, reason: 'storage-error' };
        }
      }

      try {
        if (!storage || typeof storage.setItem !== 'function') throw new Error('Storage is unavailable.');
        storage.setItem(MOVE_HAPTICS_STORAGE_KEY, '1');
      } catch (_error) {
        return { enabled: false, persisted: false, reason: 'storage-error' };
      }
      invalidate();
      enabled = true;
      return { enabled: true, persisted: true };
    },

    setActive(nextActive) {
      const next = nextActive === true;
      if (active === next) return;
      active = next;
      if (!active) invalidate();
    },

    setHost(nextHost) {
      if (Object.is(host, nextHost)) return;
      host = nextHost;
      invalidate();
    },

    invalidate,

    request() {
      if (!enabled) return Promise.resolve('disabled');
      if (!active || disposed || !isActive()) return Promise.resolve('inactive');
      if (inFlight) return Promise.resolve('busy');
      if (typeof requestMoveHaptic !== 'function') return Promise.resolve('unavailable');

      const id = ++sequence;
      const requestGeneration = generation;
      let resolveResult;
      const resultPromise = new Promise((resolve) => { resolveResult = resolve; });
      const pending = { id, generation: requestGeneration, timer: null, resolve: resolveResult, stale: false, timedOut: false, dispatched: false };
      inFlight = pending;
      pending.timer = setTimeoutFn(() => {
        if (inFlight !== pending || pending.timedOut) return;
        pending.timedOut = true;
        pending.timer = null;
        pending.resolve('timeout');
      }, timeoutMs);
      Promise.resolve().then(() => {
        if (inFlight !== pending || pending.stale || pending.generation !== generation
          || disposed || !enabled || !active || !isActive()) {
          if (inFlight === pending) inFlight = null;
          pending.resolve('stale');
          return NOT_DISPATCHED;
        }
        pending.dispatched = true;
        try { return requestMoveHaptic(); }
        catch (_error) { return Promise.reject(_error); }
      }).then(
        (nativeResult) => { if (nativeResult !== NOT_DISPATCHED) finishNative(pending, normalizeNativeStatus(nativeResult)); },
        () => finishNative(pending, 'error'),
      );
      return resultPromise;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      enabled = false;
      invalidate();
    },
  };
}
