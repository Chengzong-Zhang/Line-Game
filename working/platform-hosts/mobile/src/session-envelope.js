export const SESSION_ENVELOPE_FORMAT = 'lifeline-local-session-envelope';
export const SESSION_ENVELOPE_VERSION = 1;
export const LEGACY_NATIVE_TOMBSTONES = Object.freeze(['__lifeline_native_session_cleared_v1__', '__LIFELINE_CLEARED_V1__']);

export function createSessionEnvelope({ revision, state, payload = null }) {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('Session revision must be a positive safe integer.');
  if (state === 'saved' && typeof payload !== 'string') throw new TypeError('Saved session envelopes need a string payload.');
  if (state !== 'saved' && state !== 'cleared') throw new TypeError('Session envelope state must be saved or cleared.');
  return Object.freeze({
    format: SESSION_ENVELOPE_FORMAT,
    version: SESSION_ENVELOPE_VERSION,
    revision,
    state,
    ...(state === 'saved' ? { payload } : {}),
  });
}

export function serializeSessionEnvelope(envelope) {
  return JSON.stringify(createSessionEnvelope(envelope));
}

export function inspectSessionEnvelope(raw, { parseSession, legacyCleared = false } = {}) {
  if (raw == null || raw === '') {
    return legacyCleared
      ? { kind: 'cleared', revision: 0, legacy: true, raw: null }
      : { kind: 'missing', raw: null };
  }
  if (LEGACY_NATIVE_TOMBSTONES.includes(raw) || (raw === '1' && legacyCleared)) {
    return { kind: 'cleared', revision: 0, legacy: true, raw };
  }
  if (typeof raw !== 'string') return { kind: 'corrupt', raw };

  let value;
  try { value = JSON.parse(raw); }
  catch (_error) { value = null; }
  if (value && value.format === SESSION_ENVELOPE_FORMAT) {
    if (value.version !== SESSION_ENVELOPE_VERSION || !Number.isSafeInteger(value.revision) || value.revision < 1) {
      return { kind: 'corrupt', raw };
    }
    if (value.state === 'cleared' && !Object.prototype.hasOwnProperty.call(value, 'payload')) {
      return { kind: 'cleared', revision: value.revision, legacy: false, raw, envelope: value };
    }
    if (value.state === 'saved' && typeof value.payload === 'string' && parseSession(value.payload)) {
      return { kind: 'saved', revision: value.revision, payload: value.payload, legacy: false, raw, envelope: value };
    }
    return { kind: 'corrupt', raw };
  }

  if (parseSession(raw)) return { kind: 'saved', revision: 0, payload: raw, legacy: true, raw };
  return { kind: 'corrupt', raw };
}

function sameCandidate(left, right) {
  return left.kind === right.kind
    && (left.kind === 'cleared' || left.payload === right.payload);
}

export function reconcileSessionEnvelopes({ localValue, nativeValue, legacyCleared = false, parseSession }) {
  const local = inspectSessionEnvelope(localValue, { parseSession, legacyCleared: legacyCleared && localValue == null });
  const native = inspectSessionEnvelope(nativeValue, { parseSession });
  const candidates = [local, native].filter(({ kind }) => kind === 'saved' || kind === 'cleared');
  const corrupt = [local, native].filter(({ kind }) => kind === 'corrupt');
  // A revisioned local clear is newer, explicit evidence that supersedes the
  // legacy marker. A saved/corrupt local record remains unordered against it.
  if (legacyCleared && localValue != null && local.kind !== 'cleared') {
    return Object.freeze({ status: 'conflict', blocked: true, selected: null, local, native, maxRevision: Math.max(0, ...candidates.map(({ revision }) => revision)) });
  }
  if (candidates.some((candidate) => candidate.legacy && candidate.kind === 'cleared') && candidates.some((candidate) => candidate.kind === 'saved')) {
    return Object.freeze({ status: 'conflict', blocked: true, selected: null, local, native, maxRevision: Math.max(0, ...candidates.map(({ revision }) => revision)) });
  }

  if (candidates.length === 0) {
    return Object.freeze({ status: corrupt.length ? 'corrupt' : 'missing', blocked: corrupt.length > 0, selected: null, local, native, maxRevision: 0 });
  }

  const maxRevision = Math.max(...candidates.map(({ revision }) => revision));
  const newest = candidates.filter(({ revision }) => revision === maxRevision);
  if (newest.some((candidate) => !sameCandidate(candidate, newest[0]))) {
    return Object.freeze({ status: 'conflict', blocked: true, selected: null, local, native, maxRevision });
  }
  const selected = newest[0];
  if (corrupt.length) {
    return Object.freeze({ status: 'corrupt-peer', blocked: true, selected, local, native, maxRevision });
  }
  return Object.freeze({ status: 'selected', blocked: false, selected, local, native, maxRevision });
}

export function createSessionEnvelopeWriter({ storage, key, initialRevision = 0, onWrite = () => {}, onError = () => {} }) {
  let revision = initialRevision;
  let blocked = false;
  let generation = 0;
  const write = (state, payload = null, { allowConflictResolution = false } = {}) => {
    const ownGeneration = ++generation;
    if (blocked && !allowConflictResolution) {
      onError('Session persistence is paused because stored copies need recovery.', ownGeneration, state);
      return null;
    }
    if (revision >= Number.MAX_SAFE_INTEGER) {
      onError('Session revision limit reached.', ownGeneration, state);
      return null;
    }
    const capturedRevision = revision + 1;
    const serialized = serializeSessionEnvelope({ revision: capturedRevision, state, payload });
    try {
      storage.setItem(key, serialized);
    } catch (error) {
      onError('Local session storage failed.', ownGeneration, state);
      return null;
    }
    revision = capturedRevision;
    blocked = false;
    onWrite(serialized, capturedRevision, ownGeneration);
    return serialized;
  };
  return Object.freeze({
    setBlocked(value) { blocked = value === true; },
    get revision() { return revision; },
    get generation() { return generation; },
    get blocked() { return blocked; },
    writeSaved(payload) { return write('saved', payload); },
    writeCleared() { return write('cleared', null, { allowConflictResolution: true }); },
  });
}
