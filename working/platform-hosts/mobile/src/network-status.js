export const NETWORK_STATUS_TIMEOUT_MS = 5_000;

const AVAILABILITY = new Set(['available', 'unavailable', 'unknown']);
const VALIDATION = new Set(['validated', 'unvalidated', 'unknown']);
const REASONS = new Set(['permission', 'registration', 'timeout', 'unavailable', 'internal', 'background', 'browser-only']);

export function unknownNetworkStatus(source, revision = 0, reason = 'unavailable') {
  return { schemaVersion: 1, source, revision, availability: 'unknown', validation: 'unknown', reason: REASONS.has(reason) ? reason : 'internal' };
}

export function normalizeNetworkStatus(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1 || value.source !== source
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !AVAILABILITY.has(value.availability) || !VALIDATION.has(value.validation)
    || Object.keys(value).some((key) => !['schemaVersion', 'source', 'revision', 'availability', 'validation', 'reason'].includes(key))
    || (value.reason !== undefined && !REASONS.has(value.reason))) {
    return unknownNetworkStatus(source, 0, 'internal');
  }
  return {
    schemaVersion: 1, source, revision: value.revision,
    availability: value.availability, validation: value.validation,
    ...(value.reason ? { reason: value.reason } : {}),
  };
}

export function createNetworkStatusController({ source, getNativeStatus, listenNative, startNative, stopNative, isNative = true, timeoutMs = NETWORK_STATUS_TIMEOUT_MS }) {
  const random = new Uint32Array(2);
  try { globalThis.crypto?.getRandomValues?.(random); } catch (_error) {}
  const controllerNonce = [...random].map((word) => word.toString(16).padStart(8, '0')).join('') || Date.now().toString(16).padStart(16, '0').slice(-16);
  let snapshot = unknownNetworkStatus(source, 0, isNative ? 'unavailable' : 'browser-only');
  let hostRevision = -1;
  let epoch = 0;
  let active = globalThis.__LIFELINE_APP_ACTIVE__ !== false;
  let starting = null;
  let listenerHandle = null;
  let listenerPending = null;
  let nativeStarted = false;
  let currentToken = '';
  let desired = false;
  let cleanupPromise = null;
  let cleanupBlocked = false;
  let getSequence = 0;
  const listeners = new Set();

  const emit = () => {
    for (const listener of [...listeners]) { try { listener(snapshot); } catch (_error) {} }
  };
  const accept = (raw, expectedEpoch = epoch) => {
    if (!active || expectedEpoch !== epoch) return snapshot;
    const value = normalizeNetworkStatus(raw, source);
    if (value.reason === 'internal' || value.revision <= hostRevision) return snapshot;
    hostRevision = value.revision;
    snapshot = value;
    emit();
    return snapshot;
  };
  const unknown = (reason) => {
    snapshot = unknownNetworkStatus(source, Math.max(0, hostRevision), reason);
    emit();
    return snapshot;
  };
  const withTimeout = (promise) => new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(Object.assign(new Error('Network status operation timed out.'), { code: 'timeout' })), timeoutMs);
    Promise.resolve(promise).then(resolve, reject).finally(() => globalThis.clearTimeout(timer));
  });

  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    const token = currentToken;
    const pendingHandle = listenerPending;
    if (!token && !listenerHandle && !pendingHandle) { cleanupBlocked = false; return Promise.resolve(); }
    cleanupBlocked = true;
    cleanupPromise = (async () => {
      if (pendingHandle) await withTimeout(pendingHandle);
      const handle = listenerHandle;
      if (handle) {
        await withTimeout(Promise.resolve().then(() => handle.remove?.()));
        if (listenerHandle === handle) listenerHandle = null;
      }
      if (token) await withTimeout(stopNative?.(token));
      if (currentToken === token) currentToken = '';
      nativeStarted = false;
      cleanupBlocked = false;
    })().finally(() => { cleanupPromise = null; });
    return cleanupPromise;
  };

  const startIfNeeded = () => {
    if (!isNative || !active || listeners.size === 0) return starting;
    if (cleanupPromise) return cleanupPromise.then(
      () => startIfNeeded(),
      () => { cleanupBlocked = true; return cleanup().then(() => startIfNeeded()); },
    );
    if (cleanupBlocked) return cleanup().then(() => startIfNeeded());
    if (starting || nativeStarted) return starting;
    const ownEpoch = ++epoch;
    const token = `${controllerNonce}.${ownEpoch}`;
    currentToken = token;
    desired = true;
    starting = (async () => {
      try {
        if (listenNative) {
          let timedOut = false;
          const pendingHandle = Promise.resolve().then(() => listenNative((event) => accept(event, ownEpoch), token)).then(async (handle) => {
            if (timedOut || ownEpoch !== epoch || listeners.size === 0) {
              try {
                await handle?.remove?.();
                if (listenerHandle === handle) listenerHandle = null;
              } catch (_error) { listenerHandle = handle; cleanupBlocked = true; throw _error; }
              if (listenerPending === pendingHandle) listenerPending = null;
              return null;
            }
            listenerHandle = handle;
            if (listenerPending === pendingHandle) listenerPending = null;
            return handle;
          }, (error) => {
            if (listenerPending === pendingHandle) listenerPending = null;
            throw error;
          });
          listenerPending = pendingHandle;
          try { await withTimeout(pendingHandle); }
          catch (error) {
            timedOut = true;
            void pendingHandle.catch(() => {});
            throw error;
          }
          if (!active || ownEpoch !== epoch || listeners.size === 0) { await cleanup(); return snapshot; }
        }
        const initial = await withTimeout(startNative(token));
        if (normalizeNetworkStatus(initial, source).reason === 'internal') throw new Error('Invalid network status response.');
        if (!active || ownEpoch !== epoch || listeners.size === 0) {
          try { await withTimeout(stopNative?.(token)); } catch (_error) { cleanupBlocked = true; currentToken = token; }
          return snapshot;
        }
        nativeStarted = true;
        accept(initial, ownEpoch);
        return snapshot;
      } catch (error) {
        if (ownEpoch === epoch) {
          unknown(error?.code === 'timeout' ? 'timeout' : 'registration');
          try { await cleanup(); } catch (_error) { cleanupBlocked = true; }
        }
        throw error;
      } finally {
        if (ownEpoch === epoch) starting = null;
      }
    })();
    return starting;
  };

  const onLifecycle = (event) => {
    if (event.type === 'lifeline:background') {
      active = false;
      desired = listeners.size > 0;
      epoch += 1;
      unknown('background');
      starting = null;
      void cleanup().catch(() => { cleanupBlocked = true; });
    } else if (event.type === 'lifeline:foreground') {
      active = true;
      if (desired && listeners.size > 0) void startIfNeeded()?.catch(() => {});
    }
  };
  const onPageHide = () => {
    active = false;
    desired = listeners.size > 0;
    epoch += 1;
    unknown('background');
    starting = null;
    void cleanup().catch(() => { cleanupBlocked = true; });
  };
  const onPageShow = () => {
    active = globalThis.__LIFELINE_APP_ACTIVE__ !== false;
    if (active && desired && listeners.size > 0) void startIfNeeded()?.catch(() => {});
  };
  globalThis.addEventListener?.('lifeline:background', onLifecycle);
  globalThis.addEventListener?.('lifeline:foreground', onLifecycle);
  globalThis.addEventListener?.('pagehide', onPageHide);
  globalThis.addEventListener?.('pageshow', onPageShow);

  return Object.freeze({
    async getStatus() {
      if (!isNative) return unknownNetworkStatus(source, Math.max(0, hostRevision), 'browser-only');
      if (!active || globalThis.__LIFELINE_APP_ACTIVE__ === false) return unknownNetworkStatus(source, Math.max(0, hostRevision), 'background');
      const ownEpoch = epoch;
      const ownRequest = ++getSequence;
      try {
        const value = await withTimeout(getNativeStatus());
        if (!active || ownEpoch !== epoch) return unknownNetworkStatus(source, Math.max(0, hostRevision), 'background');
        if (ownRequest !== getSequence) return snapshot;
        if (normalizeNetworkStatus(value, source).reason === 'internal') return unknownNetworkStatus(source, Math.max(0, hostRevision), 'internal');
        return accept(value, ownEpoch);
      } catch (error) {
        if (ownRequest !== getSequence) return snapshot;
        return unknownNetworkStatus(source, Math.max(0, hostRevision), error?.code === 'timeout' ? 'timeout' : 'unavailable');
      }
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Network status listener must be a function.');
      listeners.add(listener);
      desired = true;
      try { listener(snapshot); } catch (_error) {}
      if (active) void startIfNeeded()?.catch(() => {});
      let cancelled = false;
      return () => {
        if (cancelled) return;
        cancelled = true;
        listeners.delete(listener);
        if (listeners.size === 0) {
          desired = false;
          epoch += 1;
          unknown(active ? 'unavailable' : 'background');
          starting = null;
          void cleanup().catch(() => { cleanupBlocked = true; });
        }
      };
    },
  });
}
