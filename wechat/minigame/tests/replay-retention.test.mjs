import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, memoryStorage } from './helpers.mjs';

const legacy = 'lifeline-wechat-library-v1', key = 'lifeline-wechat-library-v2';
const actions = [];
const played = new sut.GameEngine({ ...sut.settingsFor(9), deferTerritoryUpdates: true });
played._isReplayingBatch = true;
for (let i = 0; i < 3; i++) {
  const point = played.getLegalMoves()[0].point;
  actions.push({ type: 'move', point }); assert.equal(played.playMove(point).success, true);
}
actions.push({ type: 'resign', player: played.currentPlayer });
function payload(i = 0, extra = {}) {
  return { session: sut.createLocalGameSession({ ...sut.settingsFor(9), turnTimeLimitSeconds: 15 + i }, actions),
    mode: 'human', difficulty: 'normal', ...extra };
}
const id = p => sut.checksum({ settings: p.session.settings, actions: p.session.actions, mode: p.mode, difficulty: p.difficulty });
function oldRecord(entries, sequence) {
  return JSON.stringify({ version: 1, sequence, entries, hash: sut.checksum({ sequence, entries }) });
}
function slots(storage) {
  return [0, 1].map(slot => { const raw = storage.get(`${key}-${slot}`); return raw ? { ...JSON.parse(raw), slot } : null; })
    .filter(Boolean).sort((a, b) => b.sequence - a.sequence);
}

test('100 replays retain complete payloads; 101st removes the oldest and never raises capacity error', () => {
  const storage = memoryStorage(), library = new sut.ReplayLibrary(storage), ids = [];
  assert.equal(sut.MAX_SAVED_GAMES, 100);
  assert.equal(sut.restoreGame(payload().session.settings, actions).gameOver, true);
  for (let i = 0; i < 100; i++) ids.push(library.save(payload(i)));
  const full = library.read();
  assert.equal(full.entries.length, 100);
  assert.deepEqual(new Set(full.entries.map(entry => entry.id)), new Set(ids));
  assert.deepEqual(full.entries[0].payload.session.actions, payload(99).session.actions);
  const latest = library.save(payload(100)), retained = library.read();
  assert.equal(retained.entries.length, 100);
  assert.equal(retained.entries[0].id, latest);
  assert.equal(retained.entries.some(entry => entry.id === ids[0]), false);
  assert.equal(retained.entries.some(entry => entry.id === ids[1]), true);
  assert.deepEqual(new sut.ReplayLibrary(storage).read(), retained, 'restart reads the same hundred complete games');
});

test('same-time saves and a backwards clock have stable eviction; duplicate saves refresh instead of consuming capacity', () => {
  const storage = memoryStorage(), library = new sut.ReplayLibrary(storage), now = Date.now;
  try {
    Date.now = () => 1000;
    const ids = Array.from({ length: 100 }, (_, i) => library.save(payload(i)));
    assert.equal(library.save(payload(0)), ids[0]);
    assert.equal(library.read().entries.length, 100);
    Date.now = () => 500;
    library.save(payload(100));
    const entries = library.read().entries;
    assert.equal(entries[0].id, id(payload(100)));
    assert.equal(entries.some(entry => entry.id === ids[0]), true);
    assert.equal(entries.some(entry => entry.id === ids[1]), false);
  } finally { Date.now = now; }
});

test('old v1 slots migrate lazily; failed migration preserves original slots; two durable v2 indexes retire v1', () => {
  const storage = memoryStorage(), library = new sut.ReplayLibrary(storage);
  const entries = Array.from({ length: 20 }, (_, i) => ({ id: id(payload(i)), savedAt: 1000 + i, payload: payload(i) })).reverse();
  storage.set(`${legacy}-0`, oldRecord(entries.slice(1), 3));
  storage.set(`${legacy}-1`, oldRecord(entries, 4));
  const original = new Map(storage.map);
  assert.equal(library.read().entries.length, 20);
  assert.deepEqual(storage.map, original, 'read does not migrate or overwrite legacy data');
  const write = storage.set; storage.set = (k, v) => { if (k === `${key}-0`) throw Error('QUOTA'); write(k, v); };
  assert.throws(() => library.save(payload(20)), /QUOTA/);
  assert.equal(storage.get(`${legacy}-0`), original.get(`${legacy}-0`));
  assert.equal(storage.get(`${legacy}-1`), original.get(`${legacy}-1`));
  assert.deepEqual(new sut.ReplayLibrary(storage).read().entries, entries);
  storage.set = write; library.save(payload(20));
  assert.equal(library.read().entries.length, 21);
  assert.equal(storage.get(`${legacy}-1`), original.get(`${legacy}-1`));
  library.save(payload(21));
  assert.equal(library.read().entries.length, 22);
  assert.ok(!storage.get(`${legacy}-0`) && !storage.get(`${legacy}-1`));
  for (const entry of entries) assert.ok(library.read().entries.some(current => current.id === entry.id));
});

test('a torn newest index or replay recovers the prior snapshot; failed writes never remove the last good games', () => {
  for (const damage of ['index', 'entry']) {
    const storage = memoryStorage(), library = new sut.ReplayLibrary(storage);
    library.save(payload(0)); const before = library.read(); library.save(payload(1));
    const current = slots(storage)[0];
    storage.set(damage === 'index' ? `${key}-${current.slot}` : current.entries[0].key, '{torn');
    assert.deepEqual(library.read().entries, before.entries);
    assert.equal(library.read().recovered, true);
    assert.deepEqual(new sut.ReplayLibrary(storage).read().entries, before.entries);
    const write = storage.set; storage.set = (k, v) => { if (/^lifeline-wechat-library-v2-[01]$/.test(k)) return; write(k, v); };
    assert.throws(() => library.save(payload(2)), /SAVE_WRITE_FAILED/);
    storage.set = write;
    assert.deepEqual(library.read().entries, before.entries);
  }
});

test('each normal save writes one replay and one small index, preserves unrelated storage and bounds orphan retention', () => {
  const storage = memoryStorage(), library = new sut.ReplayLibrary(storage), written = [];
  const set = storage.set;
  storage.set = (k, v) => { if (v) written.push({ key: k, bytes: Buffer.byteLength(v) }); set(k, v); };
  storage.set('unrelated-game-data', 'keep');
  for (let i = 0; i < 100; i++) library.save(payload(i));
  written.length = 0; library.save(payload(100));
  assert.equal(written.length, 2);
  assert.equal(written.filter(item => item.key.startsWith(`${key}-entry-`)).length, 1);
  assert.ok(written.every(item => item.bytes < 1024 * 1024));
  assert.equal(storage.get('unrelated-game-data'), 'keep');
  library.save(payload(101));
  const content = [...storage.map].filter(([k, v]) => k.startsWith(`${key}-entry-`) && v);
  assert.equal(content.length, 101, '100 current entries plus the single previous-generation eviction');
  const read = library.read(); read.entries[0].payload.session.actions.length = 0;
  assert.equal(library.read().entries[0].payload.session.actions.length, actions.length, 'external mutations cannot poison the validation cache');
});

test('total-byte protection evicts oldest entries; single-key overflow leaves the previous library intact', () => {
  const storage = memoryStorage(), library = new sut.ReplayLibrary(storage);
  const large = 'x'.repeat(750 * 1024);
  const ids = Array.from({ length: 10 }, (_, i) => library.save(payload(i, { syntheticSizeStress: large })));
  const current = library.read();
  assert.ok(current.entries.length < 10 && current.entries.length > 1);
  assert.equal(current.entries[0].id, ids.at(-1));
  assert.equal(current.entries.some(entry => entry.id === ids[0]), false);
  assert.ok(slots(storage)[0].entries.reduce((n, entry) => n + entry.bytes, 0) <= sut.MAX_LIBRARY_BYTES);
  assert.ok([...storage.map.values()].every(raw => Buffer.byteLength(raw) < 1024 * 1024));
  assert.throws(() => library.save(payload(20, { syntheticSizeStress: 'x'.repeat(1024 * 1024) })), /LIBRARY_FULL/);
  assert.deepEqual(library.read(), current);
});

test('forged reference metadata cannot bypass checks through a shared cached content key', () => {
  const storage = memoryStorage(), library = new sut.ReplayLibrary(storage);
  library.save(payload(0)); library.save(payload(1));
  const before = library.read(), current = slots(storage)[0];
  const refs = current.entries.map(entry => ({ ...entry })); refs[1].bytes++;
  storage.set(`${key}-${current.slot}`, JSON.stringify({ ...current, entries: refs,
    hash: sut.checksum({ sequence: current.sequence, entries: refs }) }));
  const recovered = library.read();
  assert.equal(recovered.recovered, true);
  assert.deepEqual(recovered.entries, before.entries.slice(1));
});

test('duplicate immutable payload is not rewritten, and failed 101st index keeps every previous game', () => {
  const storage = memoryStorage(), library = new sut.ReplayLibrary(storage), now = Date.now, set = storage.set;
  try {
    Date.now = () => 1000;
    const original = payload(); library.save(original);
    storage.set = (k, v) => { if (k.startsWith(`${key}-entry-`)) throw Error('IMMUTABLE_REWRITE'); set(k, v); };
    assert.doesNotThrow(() => library.save(original));
    storage.set = set;
    for (let i = 1; i < 100; i++) library.save(payload(i));
    const before = library.read();
    storage.set = (k, v) => { if (/^lifeline-wechat-library-v2-[01]$/.test(k)) throw Error('QUOTA'); set(k, v); };
    assert.throws(() => library.save(payload(100)), /QUOTA/);
    storage.set = set;
    assert.deepEqual(library.read(), before);
    assert.deepEqual(new sut.ReplayLibrary(storage).read(), before);
  } finally { Date.now = now; storage.set = set; }
});
