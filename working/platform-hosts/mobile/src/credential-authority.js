const MAX_TOKEN_LENGTH = 16_384;
const MAX_USERNAME_LENGTH = 50;
const OPERATION_TIMEOUT_MS = 15_000;
const LOCAL_CLEAR_BARRIER_KEY = 'lifeline-auth-clear-pending-v1';

let operationTail = Promise.resolve();

function boundedCredential(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || Object.keys(value).some((key) => !['token', 'username'].includes(key))
    || typeof value.token !== 'string' || value.token.length === 0 || value.token.length > MAX_TOKEN_LENGTH
    || typeof value.username !== 'string' || value.username.trim().length === 0
    || [...value.username].length > MAX_USERNAME_LENGTH) {
    throw new Error('Credential record is invalid or exceeds its size limit.');
  }
  return { token: value.token, username: value.username };
}

function withTimeout(promise, label, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = globalThis.setTimeout(() => reject(Object.assign(new Error(`${label} timed out; completion is unknown.`), { code: 'unknown' })), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => globalThis.clearTimeout(timer));
}

function serialize(operation) {
  const result = operationTail.then(operation, operation);
  // Keep the native operation in the tail after the caller times out. A timeout
  // cannot cancel a platform crypto or durable-file operation.
  operationTail = result.catch(() => {});
  return result;
}

export function createCredentialAuthority({ provider, storage, onStatus = () => {}, timeoutMs = OPERATION_TIMEOUT_MS }) {
  let lease = null;
  // A timed-out native write may still complete. Do not issue a new login
  // attempt until that underlying operation, not merely its timeout, settles.
  let activeCommit = false;
  let state = 'unavailable';
  let generation = 0;
  const publish = (next, detail = {}) => {
    state = next;
    onStatus({ state: next, ...detail });
  };
  const clearLegacy = () => {
    if (!storage || typeof storage.removeItem !== 'function') throw new Error('Credential migration storage is unavailable.');
    storage.removeItem('triaxis-auth');
  };
  const localClearPending = () => {
    if (!storage || typeof storage.getItem !== 'function') throw new Error('Credential suppression storage is unavailable.');
    return storage.getItem(LOCAL_CLEAR_BARRIER_KEY) === 'pending';
  };
  const writeLocalClearPending = () => {
    if (!storage || typeof storage.setItem !== 'function') throw new Error('Credential suppression storage is unavailable.');
    storage.setItem(LOCAL_CLEAR_BARRIER_KEY, 'pending');
  };
  const removeLocalClearPending = () => {
    if (!storage || typeof storage.removeItem !== 'function') throw new Error('Credential suppression storage is unavailable.');
    storage.removeItem(LOCAL_CLEAR_BARRIER_KEY);
  };

  async function run(operation) { return withTimeout(serialize(operation), 'Credential operation', timeoutMs); }

  async function bootstrap() {
    if (!provider) { publish('unavailable'); return { state }; }
    const ownGeneration = ++generation;
    publish('loading');
    try {
      const claimed = await run(() => provider.claim({ expectedOwnerGeneration: lease?.ownerGeneration ?? -1 }));
      if (generation !== ownGeneration) return { state: 'unknown' };
      lease = claimed;
      if (localClearPending()) {
        const cleared = await run(() => provider.clear(lease));
        if (generation !== ownGeneration) return { state: 'unknown' };
        if (cleared?.durable !== true) throw new Error('Credential clear barrier durability was not confirmed.');
        clearLegacy();
        removeLocalClearPending();
        globalThis.__LIFELINE_AUTH_BOOTSTRAP__ = { token: null, username: null };
        publish('ready');
        return { state, credential: null };
      }
      const result = await run(() => provider.load(lease));
      if (generation !== ownGeneration) return { state: 'unknown' };
      if (result?.state === 'present') {
        const credential = boundedCredential(result.credential);
        clearLegacy();
        if (generation !== ownGeneration) return { state: 'unknown' };
        globalThis.__LIFELINE_AUTH_BOOTSTRAP__ = credential;
        publish('ready');
        return { state, credential };
      }
      if (result?.state === 'cleared') {
        globalThis.__LIFELINE_AUTH_BOOTSTRAP__ = { token: null, username: null };
        clearLegacy();
        publish('ready');
        return { state, credential: null };
      }
      if (result?.state !== 'missing') throw new Error('Native credential state is invalid.');
      let legacy = null;
      if (!storage || typeof storage.getItem !== 'function') throw new Error('Legacy credential storage is unavailable.');
      const legacyRaw = storage.getItem('triaxis-auth');
      if (legacyRaw !== null && legacyRaw !== undefined && legacyRaw !== '') {
        try { legacy = JSON.parse(legacyRaw); } catch (_error) { throw new Error('Legacy credential record is malformed.'); }
        if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)
          || Object.keys(legacy).length !== 2 || Object.keys(legacy).some((key) => !['token', 'username'].includes(key))) {
          throw new Error('Legacy credential record is malformed.');
        }
      }
      if (legacy !== null) {
        const credential = boundedCredential(legacy);
        const saved = await run(() => provider.save(lease, credential));
        if (saved?.durable !== true) throw new Error('Credential migration durability was not confirmed.');
        if (generation !== ownGeneration) return { state: 'unknown' };
        const verify = await run(() => provider.load(lease));
        if (generation !== ownGeneration) return { state: 'unknown' };
        if (verify?.state !== 'present') throw new Error('Credential migration read-back failed.');
        const verifiedCredential = boundedCredential(verify.credential);
        if (verifiedCredential.token !== credential.token || verifiedCredential.username !== credential.username) throw new Error('Credential migration read-back failed.');
        globalThis.__LIFELINE_AUTH_BOOTSTRAP__ = credential;
        clearLegacy();
      } else {
        globalThis.__LIFELINE_AUTH_BOOTSTRAP__ = { token: null, username: null };
      }
      publish('ready');
      return { state, credential: globalThis.__LIFELINE_AUTH_BOOTSTRAP__ };
    } catch (_error) {
      // Never expose credential or provider error text in status surfaces.
      if (generation === ownGeneration) {
        publish('error');
        globalThis.__LIFELINE_AUTH_BOOTSTRAP__ = { token: null, username: null };
      }
      return { state };
    }
  }

  async function retry() {
    invalidate();
    return bootstrap();
  }

  function save(value) {
    let credential;
    try { credential = boundedCredential(value); } catch (_error) { publish('error'); return Promise.resolve(false); }
    if (state !== 'ready' || !lease || activeCommit) { publish('unknown'); return Promise.resolve(false); }
    const ownGeneration = generation;
    const ownLease = lease;
    activeCommit = true;
    return run(async () => {
      try {
      if (generation !== ownGeneration || lease !== ownLease) return false;
      const saved = await provider.save(ownLease, credential);
      if (saved?.durable !== true) throw new Error('Credential durability was not confirmed.');
      if (generation !== ownGeneration || lease !== ownLease) return false;
      const verified = await provider.load(ownLease);
      if (generation !== ownGeneration || lease !== ownLease) return false;
      if (verified?.state !== 'present') {
        throw new Error('Credential save verification failed.');
      }
      const verifiedCredential = boundedCredential(verified.credential);
      if (verifiedCredential.token !== credential.token || verifiedCredential.username !== credential.username) throw new Error('Credential save verification failed.');
      removeLocalClearPending();
      publish('ready');
      return true;
      } finally {
        activeCommit = false;
      }
    }).catch(() => { if (generation === ownGeneration) publish('unknown'); return false; });
  }

  function clear() {
    generation += 1;
    const ownGeneration = generation;
    const oldLease = lease;
    globalThis.__LIFELINE_AUTH_BOOTSTRAP__ = { token: null, username: null };
    try {
      writeLocalClearPending();
      clearLegacy();
    } catch (_error) {
      publish('unknown');
      return Promise.resolve(false);
    }
    if (!provider || !oldLease) { publish('unavailable'); return Promise.resolve(false); }
    publish('clearing');
    const clearOperation = (async () => {
      const nextLease = await provider.claim({ expectedOwnerGeneration: oldLease.ownerGeneration });
      if (generation !== ownGeneration) return false;
      lease = nextLease;
      const cleared = await provider.clear(nextLease);
      if (cleared?.durable !== true) throw new Error('Credential clear barrier durability was not confirmed.');
      if (generation !== ownGeneration || lease !== nextLease) return false;
      removeLocalClearPending();
      publish('ready');
      return true;
    })();
    return withTimeout(clearOperation, 'Credential clear', timeoutMs).catch(() => { if (generation === ownGeneration) publish('unknown'); return false; });
  }

  function invalidate() {
    generation += 1;
    lease = null;
    globalThis.__LIFELINE_AUTH_BOOTSTRAP__ = { token: null, username: null };
    publish('unknown');
  }

  const getOwner = () => lease ? { ...lease } : null;
  const beginAttempt = () => activeCommit ? null : ({ generation: ++generation, owner: getOwner() });
  const isAttemptCurrent = (attempt) => attempt?.generation === generation && isCurrent(attempt.owner);
  const isCurrent = (owner) => generation > 0 && state === 'ready' && !!lease
    && owner?.pageEpoch === lease.pageEpoch && owner?.ownerGeneration === lease.ownerGeneration;
  return Object.freeze({ begin: bootstrap, bootstrap, retry, save, clear, invalidate, isCurrent, beginAttempt, isAttemptCurrent, getState: () => state, getOwner });
}
