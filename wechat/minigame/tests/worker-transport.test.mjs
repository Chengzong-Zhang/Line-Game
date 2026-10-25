import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, fakeWorker, memoryStorage, until, wireClone } from './helpers.mjs';
import { TEXT, errorText } from '../src/i18n.js';

test('Worker accepts reordered context fields and still serializes queued tasks', async () => {
  const worker = fakeWorker(), scheduler = new sut.ComputeScheduler(() => worker);
  const context = { epoch: 4, revision: 2, rulesVersion: 'territory-v2', player: 'BLACK' };
  try {
    const first = scheduler.request('STATE', {}, context);
    const second = scheduler.request('HINT', {}, { bench: 'opening', corpus: 'fixture' });
    // Attach handlers before injecting responses, including the pre-fix rejection.
    const settled = Promise.allSettled([first, second]);
    worker.receive(wireClone({ id: worker.sent[0].id, context, ok: true, result: 'state' }));
    worker.reply('hint');
    assert.deepEqual((await settled).map(({ status, value, reason }) => ({ status, value: value ?? reason?.message })), [
      { status: 'fulfilled', value: 'state' }, { status: 'fulfilled', value: 'hint' },
    ]);
  } finally { scheduler.cancel(); }
});

test('reordering never hides changed, missing, extra or mistyped context fields', async () => {
  const expected = { epoch: 4, revision: 2, rulesVersion: 'territory-v2', player: 'BLACK' };
  const variants = [
    { ...expected, epoch: 3 }, { ...expected, revision: 1 },
    { ...expected, rulesVersion: 'territory-v1' }, { ...expected, player: 'WHITE' },
    { ...expected, revision: '2' }, { ...expected, extra: true },
    { epoch: 4, revision: 2, rulesVersion: 'territory-v2' }, null, [],
  ];
  for (const context of variants) {
    const worker = fakeWorker(), scheduler = new sut.ComputeScheduler(() => worker);
    try {
      const rejected = assert.rejects(scheduler.request('STATE', {}, expected), /STALE_WORKER_CONTEXT/);
      worker.receive(wireClone({ id: worker.sent[0].id, context, ok: true, result: 'wrong' }));
      await rejected;
      assert.equal(worker.terminated, true);
    } finally { scheduler.cancel(); }
  }
});

for (const mode of ['human', 'ai-white', 'ai-black']) {
  test(`new game, move, save and replay survive a copying Worker bridge: ${mode}`, async () => {
    const scheduler = new sut.ComputeScheduler(() => {
      const worker = fakeWorker();
      worker.postMessage = message => {
        const incoming = wireClone(message);
        setTimeout(() => {
          if (!worker.terminated) worker.receive(wireClone(sut.handleWorkerMessage(incoming)));
        }, 1);
      };
      return worker;
    });
    const storage = memoryStorage(), store = new sut.SaveStore(storage);
    const session = new sut.GameSession(scheduler, store);
    try {
      assert.equal(await session.newGame(5, mode, 'easy'), true, 'initial STATE must show the board');
      await until(() => !session.busy);
      assert.equal(session.error, null);
      assert.equal(session.canPlay(), true);
      if (mode === 'ai-black') assert.equal(session.actions.length, 1);
      const before = session.actions.length;
      await session.hint();
      assert.equal(session.error, null);
      assert.ok(session.hintPoint);
      assert.equal(await session.act({ type: 'move', point: session.hintPoint }), true);
      await until(() => !session.busy);
      assert.equal(session.error, null);
      assert.equal(session.actions.length, before + (mode === 'human' ? 1 : 2));
      const hash = session.stateHash, count = session.actions.length;
      assert.equal(store.read().payload.session.actions.length, count);
      await session.replay(0);
      assert.equal(session.error, null);
      assert.equal(session.replayIndex, 0);
      await session.exitReplay();
      assert.equal(session.stateHash, hash);
      assert.equal(await session.restore(), true);
      assert.equal(session.stateHash, hash);
    } finally { scheduler.cancel(); }
  });
}

test('local stale computation explains recovery without claiming online synchronization', () => {
  for (const t of Object.values(TEXT)) {
    for (const code of ['STALE_WORKER_CONTEXT', 'STALE_AI', 'STALE_HINT']) {
      assert.equal(errorText(code, t), t.computeRetry);
    }
    assert.equal(errorText('STALE_MATCH', t), t.stalePosition);
  }
});
