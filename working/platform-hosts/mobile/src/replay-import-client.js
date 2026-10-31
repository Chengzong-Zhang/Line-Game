export const REPLAY_IMPORT_MAX_BYTES = 4_000_000;

function errorWithCode(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function replayTextByteLength(value) {
  return new TextEncoder().encode(String(value)).byteLength;
}

export function normalizeReplayImportResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw errorWithCode('invalid-response', 'Could not read the selected replay file.');
  }
  if (value.status === 'cancelled' && Object.keys(value).length === 1) return { status: 'cancelled' };
  if (value.status === 'too-large' && Object.keys(value).length === 1) {
    throw errorWithCode('too-large', 'Replay file exceeds the 4,000,000-byte limit.');
  }
  if (value.status !== 'selected' || Object.keys(value).length !== 2
    || Object.keys(value).some((key) => key !== 'status' && key !== 'text')
    || typeof value.text !== 'string') {
    throw errorWithCode('invalid-response', 'Could not read the selected replay file.');
  }
  if (replayTextByteLength(value.text) > REPLAY_IMPORT_MAX_BYTES) {
    throw errorWithCode('too-large', 'Replay file exceeds the 4,000,000-byte limit.');
  }
  return { status: 'selected', text: value.text };
}

export function createReplayImportClient({ select, getOwnerToken = () => null }) {
  if (typeof select !== 'function') throw new TypeError('A replay selection provider is required.');
  let sequence = 0;
  let generation = 0;
  let active = null;

  const importReplay = async () => {
    if (active) throw errorWithCode('busy', 'A replay file selection is already active.');
    const request = { id: ++sequence, generation, ownerToken: getOwnerToken() };
    active = request;
    try {
      const result = await select();
      if (active !== request || generation !== request.generation || getOwnerToken() !== request.ownerToken) {
        return { status: 'cancelled' };
      }
      return normalizeReplayImportResult(result);
    } catch (error) {
      if (active !== request || generation !== request.generation || getOwnerToken() !== request.ownerToken) {
        return { status: 'cancelled' };
      }
      if (error?.code === 'too-large' || error?.code === 'REPLAY_TOO_LARGE') {
        throw errorWithCode('too-large', 'Replay file exceeds the 4,000,000-byte limit.');
      }
      if (error?.code === 'busy') {
        throw errorWithCode('busy', 'A replay file selection is already active.');
      }
      throw errorWithCode('read-failed', 'Could not read the selected replay file. Please choose it again.');
    } finally {
      if (active === request) active = null;
    }
  };

  return Object.freeze({
    importReplay,
    invalidate() {
      generation += 1;
      active = null;
    },
    get active() { return active !== null; },
  });
}
