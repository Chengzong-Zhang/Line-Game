import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, localScheduler, memoryStorage } from './helpers.mjs';
import { portableClone } from '../../../web/web前端/PortableClone.js';

test('new rooms explicitly negotiate v3 while existing v2 snapshots keep their rule version', async () => {
  const sent = [];
  const client = new sut.OnlineClient({ storage: memoryStorage() },
    { onlineEnabled: true, apiBase: 'https://test.invalid' }, localScheduler());
  client.authenticate = async () => {};
  client.request = async (endpoint, body) => { sent.push({ endpoint, body }); return { code: 'ABCDEFGH' }; };
  client.receive = async () => true; client.connect = async () => {};
  try {
    await client.enter('create', 7);
    assert.deepEqual(sent.at(-1), { endpoint: 'rooms', body: { gridSize: 7, rulesVersion: 'territory-v3',
      protectionRule: 'duel-first-unprotected-v1' } });
    await client.enter('create', { gridSize: 9, boardShape: 'hexagon' });
    assert.equal(sent.at(-1).body.rulesVersion, 'territory-v3');
    assert.equal(sent.at(-1).body.protectionRule, undefined);
    const settings = { ...sut.settingsFor(7), rulesVersion: 'territory-v2' }; delete settings.protectionRule;
    const restored = sut.restoreGame(settings);
    assert.equal(restored.rulesVersion, 'territory-v2');
    assert.equal(restored.protectionRule, 'symmetric-v1');
    assert.throws(() => sut.restoreGame({ ...settings, rulesVersion: 'unknown' }), /INVALID_SETTINGS/);
  } finally { client.detach(); client.game.scheduler.cancel(); }
});

test('continuing an old v2 save preserves it but starting a fresh local game selects v3', async () => {
  const scheduler = localScheduler();
  const session = new sut.GameSession(scheduler, { save() {}, read: () => ({}) });
  try {
    const legacy = { ...sut.settingsFor(7), rulesVersion: 'territory-v2' }; delete legacy.protectionRule;
    assert.equal(await session.load(legacy, [], { mode: 'human', paused: true }), true);
    assert.equal(session.settings.rulesVersion, 'territory-v2');
    assert.equal(session.settings.protectionRule, undefined);
    assert.equal(await session.newGame(7, 'human'), true);
    assert.equal(session.settings.rulesVersion, 'territory-v3');
    assert.equal(session.settings.protectionRule, 'duel-first-unprotected-v1');
  } finally { session.hide(); scheduler.cancel(); }
});

test('portable model and search data clone preserves types, shared references and isolation without browser clone', () => {
  const native = globalThis.structuredClone;
  globalThis.structuredClone = undefined;
  try {
    const shared = { weights: new Float32Array([1, -2, 3]) };
    const source = { shared, again: shared, map: new Map([['x', shared]]), set: new Set([shared]) };
    source.self = source;
    const copy = portableClone(source);
    assert.notEqual(copy, source); assert.equal(copy.self, copy);
    assert.equal(copy.shared, copy.again); assert.equal(copy.map.get('x'), copy.shared);
    assert.equal([...copy.set][0], copy.shared);
    assert.ok(copy.shared.weights instanceof Float32Array);
    copy.shared.weights[0] = 99; assert.equal(source.shared.weights[0], 1);
  } finally { globalThis.structuredClone = native; }
});
