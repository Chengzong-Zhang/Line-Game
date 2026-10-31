import { createSessionEnvelopeWriter, reconcileSessionEnvelopes, inspectSessionEnvelope } from './session-envelope.js';
import { createSerializedSessionMirror } from './session-mirror.js';
import { parseLocalGameSessionRecord, configureMobileLocalGameSessionWriter, parseTopologyLocalGameSessionRecord, configureMobileTopologyGameSessionWriter } from '../../web/web前端/LocalGameSession.js?v=20261023-l28a1';

const SESSION_KEY = 'lifeline-local-game-session-v1';
const CLEAR_KEY = 'lifeline-local-game-session-cleared-v1';
const TOPOLOGY_KEY = 'lifeline-topology-local-game-session-v1';

function removeLegacyClearMarker(storage) {
  try { storage.removeItem(CLEAR_KEY); } catch (_error) { /* revisioned evidence remains authoritative */ }
}

async function initializeKeyAuthority({ storage, reportStatus, native = null, key, clearKey, parseSession, configureWriter }) {
  const emitStatus = (state, error = null, details = {}) => reportStatus(state, error, {
    nativeAvailable: Boolean(native),
    key, ...details,
  });
  let mirror = null;
  if (native) mirror = createSerializedSessionMirror({ write: (value) => native.write(value, key), remove: async () => { throw new Error('Envelope clears must be persisted as records.'); } });
  let localValue = null;
  let nativeValue = null;
  let legacyCleared = false;
  try {
    localValue = storage.getItem(key);
    legacyCleared = clearKey ? storage.getItem(clearKey) === '1' : false;
  } catch (error) {
    emitStatus('error', 'Local session storage failed.', { source: 'local', operation: 'read' });
    throw error;
  }
  if (native) {
    try {
      nativeValue = (await native.load(key))?.value ?? null;
    } catch (error) {
      emitStatus('error', 'Native session storage failed.', { source: 'native', operation: 'read' });
      throw error;
    }
  }

  const recovery = reconcileSessionEnvelopes({ localValue, nativeValue, legacyCleared, parseSession });
  const initialRevision = recovery.maxRevision;
  const localState = inspectSessionEnvelope(localValue, { parseSession, legacyCleared: legacyCleared && !localValue });
  const writer = createSessionEnvelopeWriter({
    storage,
    key,
    initialRevision,
    onWrite(serialized, _revision, generation) {
      const record = JSON.parse(serialized);
      // The envelope has now been committed locally, so it supersedes the
      // pre-envelope clear marker. If removal is unavailable, startup accepts
      // a revisioned clear as concordant evidence and retries cleanup there.
      if (clearKey) removeLegacyClearMarker(storage);
      const isCurrentAttempt = () => writer.generation === generation;
      if (!mirror) {
        if (isCurrentAttempt()) emitStatus(record.state === 'cleared' ? 'cleared' : 'confirmed', null, {
          source: 'local', operation: record.state,
        });
        return;
      }
      emitStatus('pending', null, { source: 'local', operation: record.state });
      const operation = mirror.save(serialized);
      void operation.then(() => {
        if (isCurrentAttempt() && operation.isCurrent()) emitStatus(record.state === 'cleared' ? 'cleared' : 'confirmed', null, {
          source: 'native', operation: record.state,
        });
      }, (error) => {
        if (isCurrentAttempt() && operation.isCurrent()) emitStatus('error', 'Native session storage failed.', {
          source: 'native', operation: record.state,
        });
      });
    },
    onError(error, generation, operation) {
      if (writer.generation === generation) emitStatus('error', error, {
        source: writer.blocked ? 'recovery' : 'local', operation,
      });
    },  });
  writer.setBlocked(recovery.blocked);
  configureWriter(writer);

  if (recovery.blocked) {
    emitStatus(recovery.status, null, { source: 'recovery', operation: 'read' });
  } else if (recovery.status === 'missing') {
    if (legacyCleared && clearKey) removeLegacyClearMarker(storage);
    emitStatus('ready', null, { source: 'local', operation: 'read' });
  } else {
    const selected = recovery.selected;
    const selectedRaw = selected.legacy
      ? JSON.stringify({ format: 'lifeline-local-session-envelope', version: 1, revision: 1, state: selected.kind, ...(selected.kind === 'saved' ? { payload: selected.payload } : {}) })
      : selected.raw;
    const selectedRevision = selected.legacy ? 1 : selected.revision;
    if (selected.legacy) {
      const serialized = selected.kind === 'saved'
        ? writer.writeSaved(selected.payload)
        : writer.writeCleared();
      if (!serialized) {
        writer.setBlocked(true);
        emitStatus('error', 'Could not migrate legacy session record.', { source: 'local', operation: selected.kind });
      }
    } else {
      if (localValue !== selectedRaw) {
        try {
          storage.setItem(key, selectedRaw);
        } catch (error) {
          emitStatus('error', 'Local session storage failed.', { source: 'local', operation: 'restore' });
          throw error;
        }
      }
      if (native && nativeValue !== selectedRaw) {
        try {
          await mirror.save(selectedRaw);
        } catch (error) {
          emitStatus('error', 'Native session storage failed.', { source: 'native', operation: 'restore' });
          throw error;
        }
      }
    }
    if (legacyCleared && clearKey) removeLegacyClearMarker(storage);
    const selectedFromNative = Boolean(native && nativeValue === selectedRaw && localValue !== selectedRaw);
    const selectedOperation = selected.kind === 'cleared'
      ? 'cleared'
      : (localState.kind === 'saved' && localValue === selectedRaw ? 'load' : 'restore');
    const selectedSource = selectedFromNative ? 'native' : 'local';
    if (!writer.blocked && !selected.legacy) emitStatus(
      selected.kind === 'cleared' ? 'cleared' : (localState.kind === 'saved' && localValue === selectedRaw ? 'confirmed' : 'restored'),
      null,
      { source: selectedSource, operation: selectedOperation },
    );
    if (!writer.blocked && selected.legacy && !mirror) emitStatus(
      selected.kind === 'cleared' ? 'cleared' : 'restored', null,
      { source: selectedSource, operation: selectedOperation },
    );
  }

  return Object.freeze({ flushSessionMirror: () => mirror?.settled() ?? Promise.resolve(), writer, recovery });
}

// Both keys retain independent revisions, conflicts and native mirrors.
export async function initializeSessionAuthority({ storage, reportStatus, native = null }) {
  const statuses = new Map();
  const priority = { conflict: 4, corrupt: 4, 'corrupt-peer': 4, error: 4, pending: 3 };
  const reportKeyStatus = (state, error, details) => {
    statuses.set(details.key, { state, error, details });
    const selected = [...statuses.values()].reduce((best, current) =>
      (priority[current.state] ?? 0) > (priority[best.state] ?? 0) ? current : best);
    reportStatus(selected.state, selected.error, selected.details);
  };
  const ordinary = await initializeKeyAuthority({ storage, reportStatus: reportKeyStatus, native, key: SESSION_KEY,
    clearKey: CLEAR_KEY, parseSession: parseLocalGameSessionRecord, configureWriter: configureMobileLocalGameSessionWriter });
  const topology = await initializeKeyAuthority({ storage, reportStatus: reportKeyStatus, native, key: TOPOLOGY_KEY,
    clearKey: null, parseSession: parseTopologyLocalGameSessionRecord, configureWriter: configureMobileTopologyGameSessionWriter });
  return Object.freeze({ writer: ordinary.writer, recovery: ordinary.recovery,
    topologyWriter: topology.writer, topologyRecovery: topology.recovery,
    flushSessionMirror: async () => { await Promise.all([ordinary.flushSessionMirror(), topology.flushSessionMirror()]); } });
}
