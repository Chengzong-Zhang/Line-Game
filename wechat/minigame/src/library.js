import { checksum, utf8 } from './integrity.js';
import { validateSave } from './storage.js';

const LEGACY_KEY = 'lifeline-wechat-library-v1', LEGACY_LIMIT = 2 * 1024 * 1024;
const KEY = 'lifeline-wechat-library-v2', ENTRY_KEY = `${KEY}-entry-`, INDEX_LIMIT = 64 * 1024;
export const MAX_SAVED_GAMES = 100;
export const MAX_REPLAY_BYTES = 1000 * 1024;
export const MAX_LIBRARY_BYTES = 6 * 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));
const gameId = payload => checksum({ settings: payload.session.settings, actions: payload.session.actions,
  mode: payload.mode, difficulty: payload.difficulty, ...(payload.controllers ? { controllers: payload.controllers } : {}) });
const invalid = () => { throw new Error('INVALID'); };
const indexRaw = (sequence, entries) => JSON.stringify({ version: 2, sequence, entries, hash: checksum({ sequence, entries }) });
const newestFirst = entries => entries.map((entry, index) => ({ entry, index }))
  .sort((a, b) => b.entry.savedAt - a.entry.savedAt || a.index - b.index).map(({ entry }) => entry);

export class ReplayLibrary {
  constructor(storage) { this.storage = storage; this.cache = new Map(); }
  // Immutable content keys let a save write just one replay and a small index.
  // Read each distinct key once per operation; unchanged bytes reuse validated
  // payloads, but storage corruption is still detected on the next read.
  entry(ref, fetched) {
    if (typeof ref?.key !== 'string' || !new RegExp(`^${ENTRY_KEY}[0-9a-f]{64}$`).test(ref.key)
      || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > MAX_REPLAY_BYTES) invalid();
    let entry = fetched.get(ref.key);
    if (!entry) {
      const raw = this.storage.get(ref.key), cached = this.cache.get(ref.key);
      if (typeof raw !== 'string' || raw.length > MAX_REPLAY_BYTES) invalid();
      if (cached?.raw === raw) entry = cached.entry;
      else {
        if (utf8(raw).length !== ref.bytes) invalid();
        entry = JSON.parse(raw);
        validateSave(entry.payload);
        if (entry.id !== gameId(entry.payload) || !Number.isFinite(entry.savedAt)
          || ref.key !== `${ENTRY_KEY}${checksum(entry).slice(7)}`) invalid();
        this.cache.set(ref.key, { raw, entry, bytes: ref.bytes });
      }
    }
    if (entry.id !== ref.id || entry.savedAt !== ref.savedAt || this.cache.get(ref.key).bytes !== ref.bytes) invalid();
    fetched.set(ref.key, entry);
    return entry;
  }
  inspect() {
    const valid = [], fetched = new Map(); let damaged = 0;
    for (let slot = 0; slot < 2; slot++) {
      const raw = this.storage.get(`${KEY}-${slot}`);
      if (!raw) continue;
      try {
        if (typeof raw !== 'string' || raw.length > INDEX_LIMIT) invalid();
        const record = JSON.parse(raw);
        if (record.version !== 2 || !Number.isSafeInteger(record.sequence) || record.sequence < 1
          || !Array.isArray(record.entries) || record.entries.length > MAX_SAVED_GAMES
          || record.hash !== checksum({ sequence: record.sequence, entries: record.entries })) invalid();
        const ids = new Set(), entries = []; let bytes = 0;
        for (const ref of record.entries) {
          if (ids.has(ref.id)) invalid();
          entries.push(this.entry(ref, fetched)); ids.add(ref.id); bytes += ref.bytes;
        }
        if (bytes > MAX_LIBRARY_BYTES) invalid();
        valid.push({ ...record, refs: record.entries, entries, slot });
      } catch (_) { damaged++; }
    }
    // A v1 library remains readable until two v2 indexes are durably written.
    // Failed migration never consumes or overwrites the old backup slots.
    if (!valid.length) for (let slot = 0; slot < 2; slot++) {
      const raw = this.storage.get(`${LEGACY_KEY}-${slot}`);
      if (!raw) continue;
      try {
        if (typeof raw !== 'string' || raw.length > LEGACY_LIMIT) invalid();
        const record = JSON.parse(raw);
        if (record.version !== 1 || !Number.isSafeInteger(record.sequence) || record.sequence < 1
          || !Array.isArray(record.entries) || record.entries.length > MAX_SAVED_GAMES
          || record.hash !== checksum({ sequence: record.sequence, entries: record.entries })) invalid();
        const ids = new Set();
        for (const entry of record.entries) {
          validateSave(entry.payload);
          if (entry.id !== gameId(entry.payload) || ids.has(entry.id) || !Number.isFinite(entry.savedAt)) invalid();
          ids.add(entry.id);
        }
        valid.push({ ...record, refs: [], slot });
      } catch (_) { damaged++; }
    }
    valid.sort((a, b) => b.sequence - a.sequence);
    if (!valid.length && damaged) throw new Error('LIBRARY_DAMAGED');
    // Bound the parse cache to keys actually referenced by valid indexes.
    const keep = new Set(valid.flatMap(record => record.refs.map(ref => ref.key)));
    for (const key of this.cache.keys()) if (!keep.has(key)) this.cache.delete(key);
    return { entries: valid[0]?.entries || [], sequence: valid[0]?.sequence || 0,
      slot: valid[0]?.slot ?? 1, version: valid[0]?.version || 2, records: valid, recovered: damaged > 0 };
  }
  read() {
    const record = this.inspect();
    return { entries: clone(record.entries), sequence: record.sequence, slot: record.slot, recovered: record.recovered };
  }
  discard(key) {
    try { if (this.storage.remove) this.storage.remove(key); else this.storage.set(key, ''); } catch (_) { /* Cleanup must not undo a verified save. */ }
    this.cache.delete(key);
  }
  write(entries, previous = this.inspect()) {
    const sequence = previous.sequence + 1, existing = new Map([...previous.records].reverse().flatMap(record => record.refs.map(ref => [ref.id, ref])));
    const retained = [], serialized = new Map(); let bytes = 0;
    for (const entry of newestFirst(entries).slice(0, MAX_SAVED_GAMES)) {
      let ref = existing.get(entry.id);
      if (!ref || this.cache.get(ref.key)?.entry !== entry) {
        const raw = JSON.stringify(entry), size = utf8(raw).length;
        if (size > MAX_REPLAY_BYTES) {
          if (!retained.length) throw new Error('LIBRARY_FULL');
          break;
        }
        ref = { id: entry.id, savedAt: entry.savedAt, key: `${ENTRY_KEY}${checksum(entry).slice(7)}`, bytes: size };
        serialized.set(ref.key, { raw, entry, bytes: size });
      }
      if (bytes + ref.bytes > MAX_LIBRARY_BYTES) break;
      bytes += ref.bytes; retained.push(ref);
    }
    const raw = indexRaw(sequence, retained);
    if (raw.length > INDEX_LIMIT || !Number.isSafeInteger(sequence)) throw new Error('LIBRARY_FULL');
    const slot = previous.version === 1 ? 0 : 1 - previous.slot, key = `${KEY}-${slot}`, created = [];
    const protectedKeys = new Set(previous.records.flatMap(record => record.refs.map(ref => ref.key)));
    try {
      for (const ref of retained) {
        const value = serialized.get(ref.key);
        // Never rewrite immutable content used by the last durable index,
        // even for a same-millisecond duplicate save with the same key.
        if (!value || protectedKeys.has(ref.key)) continue;
        created.push(ref.key);
        this.storage.set(ref.key, value.raw);
        if (this.storage.get(ref.key) !== value.raw) throw new Error('SAVE_WRITE_FAILED');
        this.cache.set(ref.key, value);
      }
      this.storage.set(key, raw);
      if (this.storage.get(key) !== raw) throw new Error('SAVE_WRITE_FAILED');
    } catch (error) {
      // Preserve the last durable index and its payloads. Only new, uncommitted
      // content may be cleaned after a failed payload/index write.
      for (const key of created) this.discard(key);
      throw error;
    }
    const keep = new Set([...retained, ...(previous.version === 2 ? previous.records[0]?.refs || [] : [])].map(ref => ref.key));
    for (const old of protectedKeys) if (!keep.has(old)) this.discard(old);
    if (previous.version === 2 && previous.records.length) for (let i = 0; i < 2; i++) this.discard(`${LEGACY_KEY}-${i}`);
  }
  save(payload) {
    validateSave(payload);
    const previous = this.inspect(), { entries } = previous;
    // Stable insertion order resolves same-millisecond saves; a backwards wall
    // clock must not make the newly saved game the first eviction candidate.
    const savedAt = Math.max(Date.now(), ...entries.map(entry => entry.savedAt));
    const entry = { id: gameId(payload), savedAt, payload: clone(payload) };
    this.write([entry, ...entries.filter(item => item.id !== entry.id)], previous);
    return entry.id;
  }
  remove(id) { const previous = this.inspect(); this.write(previous.entries.filter(entry => entry.id !== id), previous); }
}
