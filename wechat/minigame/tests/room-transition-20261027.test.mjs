import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, memoryStorage, localScheduler } from './helpers.mjs';

const old = { code: 'ABCDEFGH', matchId: 'a'.repeat(32), status: 'playing', rankedAI: false };
const config = { onlineEnabled: true, apiBase: 'https://test.invalid' };

function fixture() {
  const calls = [], scheduler = localScheduler(), storage = memoryStorage();
  const client = new sut.OnlineClient({ storage }, config, scheduler);
  client.authenticate = async () => { client.account = { uid: 'one' }; };
  client.request = async (path, body) => {
    calls.push({ path, body });
    if (path === 'rooms/current') return { room: old };
    if (path.endsWith('/leave')) return { deliberatelyUnrecoverableReplay: true };
    return { code: 'JKLMNPQR' };
  };
  client.receive = async () => true;
  client.connect = async () => {};
  return { client, calls, scheduler, storage };
}

test('explicit departure does not require replaying the broken old room before creating a new one', async () => {
  const { client, calls, scheduler, storage } = fixture();
  storage.set('lifeline-wx-room-v1', old.code);
  try {
    assert.equal(await client.enter('create', { gridSize: 7, playerCount: 2, startPlayer: 'BLACK' },
      { confirmDeparture: async room => { assert.deepEqual(room, old); return true; } }), true);
    assert.deepEqual(calls.map(call => call.path), ['rooms/current', 'rooms/ABCDEFGH/leave', 'rooms']);
    assert.deepEqual(calls[1].body, { matchId: old.matchId });
    assert.equal(calls[2].body.requireNew, true);
    assert.equal(calls[2].body.protectionRule, 'duel-first-unprotected-v1');
    assert.equal(storage.get('lifeline-wx-room-v1'), 'JKLMNPQR');
  } finally { client.detach(); scheduler.cancel(); }
});

test('declining or failing the departure never creates a new room', async () => {
  for (const accept of [false, true]) {
    const { client, calls, scheduler } = fixture();
    if (accept) {
      const request = client.request;
      client.request = async (path, body) => { if (path.endsWith('/leave')) throw Error('NETWORK_ERROR'); return request(path, body); };
    }
    try {
      await assert.rejects(client.enter('ai', { profile: 'greedy' }, { confirmDeparture: async () => accept }),
        accept ? /NETWORK_ERROR/ : /CANCELLED/);
      assert.ok(!calls.some(call => call.path === 'ranked-ai'));
    } finally { client.detach(); scheduler.cancel(); }
  }
});

test('joining the same room does not prompt or leave it', async () => {
  const { client, calls, scheduler } = fixture();
  try {
    await client.enter('join', old.code, { confirmDeparture: async () => { throw Error('unexpected confirmation'); } });
    assert.deepEqual(calls.map(call => call.path), ['rooms/current', 'rooms/join']);
  } finally { client.detach(); scheduler.cancel(); }
});
