import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, fakeWorker } from './helpers.mjs';

test('singleton Worker serializes work by priority', async () => {
  const workers = [], s = new sut.ComputeScheduler(() => { const w = fakeWorker(); workers.push(w); return w; });
  const a = s.request('AI', {}, { epoch: 1 }); const b = s.request('HINT', {}, {}, 2); const c = s.request('STATE', {}, {}, 0);
  assert.equal(workers.length, 1); const w = workers[0]; assert.equal(w.sent.length, 1);
  w.reply('a'); assert.equal(await a, 'a'); assert.equal(w.sent[1].kind, 'STATE');
  w.reply('c'); assert.equal(await c, 'c'); w.reply('b'); assert.equal(await b, 'b');
  assert.equal(workers.length, 1); s.cancel();
});

test('cancel rejects pending work and excludes late old results after recreation', async () => {
  const workers = [], s = new sut.ComputeScheduler(() => { const w = fakeWorker(); workers.push(w); return w; });
  const a = s.request('STATE', {}, {}), rejected = assert.rejects(a, /CANCELLED/);
  s.cancel(); await rejected; assert.equal(workers[0].terminated, true);
  const b = s.request('STATE', {}, {}); workers[0].reply({ wrong: true }); assert.ok(s.active);
  workers[1].reply('new'); assert.equal(await b, 'new'); s.cancel();
});

test('timeouts, errors, killed processes and bad contexts recover without stale results', async () => {
  for (const fault of ['timeout', 'error', 'killed', 'context']) {
    const workers = [], s = new sut.ComputeScheduler(() => { const w = fakeWorker(); workers.push(w); return w; }, { timeoutMs: 25 });
    const failed = assert.rejects(s.request('AI', {}, { revision: 1 }), /TIMEOUT|ERROR|KILLED|CONTEXT/);
    if (fault === 'error') workers[0].error();
    if (fault === 'killed') workers[0].killed();
    if (fault === 'context') workers[0].receive({ ...workers[0].sent[0], context: {}, ok: true });
    await failed; const good = s.request('STATE', {}, {}); workers.at(-1).reply('ok'); assert.equal(await good, 'ok'); s.cancel();
  }
});
