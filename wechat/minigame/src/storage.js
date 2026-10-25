import { createLocalGameSession } from './core.js';
import { checksum } from './integrity.js';
import { validateSettings, MODES, MAX_ACTIONS } from './state.js';
import { validateControllers } from './controllers.js';
import { validatePlayProgress, validateUndoUsage } from './play-options.js';

const PREFIX = 'lifeline-wechat-session-v1';
const LIMIT = 2 * 1024 * 1024;

export function validateSave(payload) {
  const session = payload?.session;
  if (session?.format !== 'lifeline-local-session' || session.schemaVersion !== 1
    || !MODES.includes(payload.mode) || !['easy', 'normal'].includes(payload.difficulty)
    || !Array.isArray(session.actions) || session.actions.length > MAX_ACTIONS) throw new Error('INVALID_SAVE');
  validateSettings(session.settings);
  validateControllers(payload.controllers, session.settings);
  validatePlayProgress(payload.progress, session.settings);
  validateUndoUsage(payload.undoUsage, session.settings);
  createLocalGameSession(session.settings, session.actions);
  return payload;
}

export class SaveStore {
  constructor(storage) { this.storage = storage; }
  read() {
    const valid = [], invalid = [];
    for (let slot = 0; slot < 2; slot++) {
      const raw = this.storage.get(`${PREFIX}-${slot}`);
      if (raw === undefined || raw === null || raw === '') continue;
      try {
        if (typeof raw !== 'string' || raw.length > LIMIT) throw new Error('SAVE_TOO_LARGE');
        const record = JSON.parse(raw);
        if (record.version !== 1 || !Number.isSafeInteger(record.sequence) || record.sequence < 1
          || record.hash !== checksum({ sequence: record.sequence, payload: record.payload })) throw new Error('SAVE_HASH');
        validateSave(record.payload);
        valid.push({ ...record, slot });
      } catch (_) { invalid.push(slot); }
    }
    valid.sort((a, b) => b.sequence - a.sequence);
    return { records: valid, damaged: invalid, payload: valid[0]?.payload || null };
  }
  save(payload) {
    validateSave(payload);
    const { records } = this.read();
    const sequence = (records[0]?.sequence || 0) + 1;
    const slot = records.length ? 1 - records[0].slot : 0;
    const record = { version: 1, sequence, payload, hash: checksum({ sequence, payload }) };
    const raw = JSON.stringify(record);
    if (raw.length > LIMIT) throw new Error('SAVE_TOO_LARGE');
    this.storage.set(`${PREFIX}-${slot}`, raw);
    if (this.storage.get(`${PREFIX}-${slot}`) !== raw) throw new Error('SAVE_WRITE_FAILED');
    return sequence;
  }
}
