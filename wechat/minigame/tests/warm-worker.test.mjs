import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, fakeWorker, memoryStorage, wireClone } from './helpers.mjs';

test('idle cancellation reuses the sole Worker and old duplicate responses cannot settle a newer request', async () => {
  const workers = [], scheduler = new sut.ComputeScheduler(() => {
    const worker = fakeWorker(); workers.push(worker); return worker;
  });
  try {
    for (let revision = 0; revision < 5; revision++) {
      scheduler.cancel({ keepIdle: true }); scheduler.cancel({ keepIdle: true });
      const task = scheduler.request('STATE', {}, { epoch: revision + 1, revision });
      const worker = workers[0];
      if (revision) { worker.reply('old', 0); assert.ok(scheduler.active); }
      worker.reply(revision); assert.equal(await task, revision);
      assert.equal(workers.length, 1); assert.equal(worker.terminated, false);
    }
    scheduler.cancel(); assert.equal(workers[0].terminated, true);
    scheduler.cancel(); scheduler.cancel({ keepIdle: true });
    const task = scheduler.request('STATE', {}, {});
    workers[0].error(); workers[0].killed(); workers[0].reply('old');
    workers[1].reply('new'); assert.equal(await task, 'new');
  } finally { scheduler.cancel(); }
});

test('keepIdle never keeps an active Worker or queued jobs after cancel', async () => {
  const workers = [], scheduler = new sut.ComputeScheduler(() => {
    const worker = fakeWorker(); workers.push(worker); return worker;
  });
  try {
    const first = assert.rejects(scheduler.request('AI', {}, {}), /CANCELLED/);
    const queued = assert.rejects(scheduler.request('STATE', {}, {}), /CANCELLED/);
    scheduler.cancel({ keepIdle: true }); await Promise.all([first, queued]);
    assert.equal(workers[0].terminated, true); assert.equal(scheduler.queue.length, 0);
    const fresh = scheduler.request('STATE', {}, { epoch: 2 });
    workers[0].reply('old'); workers[0].error(); workers[0].killed();
    assert.ok(scheduler.active); workers[1].reply('fresh'); assert.equal(await fresh, 'fresh');
  } finally { scheduler.cancel(); }
});

test('creation and post failures detach the realm and a later request can recover', async () => {
  for (const kind of ['create', 'post']) {
    let attempts = 0, worker;
    const scheduler = new sut.ComputeScheduler(() => {
      attempts++;
      if (kind === 'create' && attempts === 1) throw Error('CREATE_FAILURE');
      worker = fakeWorker();
      if (kind === 'post' && attempts === 1) worker.postMessage = () => { throw Error('POST_FAILURE'); };
      return worker;
    });
    try {
      await assert.rejects(scheduler.request('STATE', {}, {}), /FAILURE/);
      assert.equal(scheduler.worker, null);
      scheduler.cancel({ keepIdle: true });
      const good = scheduler.request('STATE', {}, {}); worker.reply('ok'); assert.equal(await good, 'ok');
    } finally { scheduler.cancel(); }
  }
});

test('sessions reuse idle workers across normal turns, but hide and rapid restart reject stale work', async () => {
  const workers = [], scheduler = new sut.ComputeScheduler(() => {
    const worker = fakeWorker(); workers.push(worker);
    worker.postMessage = message => {
      worker.sent.push(message);
      setTimeout(async () => {
        if (worker.terminated) return;
        const result = await sut.handleWorkerMessage(wireClone(message));
        if (!worker.terminated) worker.receive(wireClone(result));
      }, 1);
    };
    return worker;
  });
  const session = new sut.GameSession(scheduler, new sut.SaveStore(memoryStorage()));
  try {
    assert.equal(await session.newGame(5, 'human'), true);
    for (let index = 0; index < 4; index++) assert.equal(await session.act({ type: 'move', point: session.snapshot.legalMoves[0].point }), true);
    assert.equal(workers.length, 1);
    const old = session.newGame(7, 'human');
    const fresh = session.newGame(5, 'human', 'easy', 3);
    assert.equal(await old, false); assert.equal(await fresh, true);
    assert.equal(session.snapshot.players.length, 3);
    const count = workers.length;
    session.hide(); assert.equal(workers.at(-1).terminated, true);
    session.show(); session.resume();
    assert.equal(await session.act({ type: 'move', point: session.snapshot.legalMoves[0].point }), true);
    assert.equal(workers.length, count + 1);
    const pending = session.newGame(7, 'human'); session.hide();
    assert.equal(await pending, false); assert.equal(session.snapshot.players.length, 3);
    assert.equal(workers.at(-1).terminated, true);
  } finally { session.hide(); scheduler.cancel(); }
});
