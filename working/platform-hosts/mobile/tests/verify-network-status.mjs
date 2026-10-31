import assert from 'node:assert/strict';
import { createNetworkStatusController } from '../src/network-status.js';

const originalAdd = globalThis.addEventListener;
const originalRemove = globalThis.removeEventListener;
const originalActive = globalThis.__LIFELINE_APP_ACTIVE__;
const eventHandlers = new Map();
globalThis.addEventListener = (name, handler) => {
  if (!eventHandlers.has(name)) eventHandlers.set(name, new Set());
  eventHandlers.get(name).add(handler);
};
globalThis.removeEventListener = (name, handler) => eventHandlers.get(name)?.delete(handler);
globalThis.__LIFELINE_APP_ACTIVE__ = true;

const fire = (type) => {
  for (const handler of [...(eventHandlers.get(type) ?? [])]) handler({ type });
};
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => setImmediate(resolve)); };
const status = (revision, availability = 'available', validation = 'validated') => ({
  schemaVersion: 1, source: 'test-native', revision, availability, validation,
});
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

try {
  {
    const reads = [];
    const controller = createNetworkStatusController({
      source: 'test-native', getNativeStatus: () => { const pending = deferred(); reads.push(pending); return pending.promise; },
      startNative: async () => status(1), stopNative: async () => {}, listenNative: null,
    });
    const older = controller.getStatus();
    const newer = controller.getStatus();
    reads[1].resolve(status(2));
    assert.equal((await newer).revision, 2);
    reads[0].resolve(status(3));
    assert.equal((await older).revision, 2, 'an older getStatus request cannot overwrite a newer query even with a larger host revision');
  }

  {
    const pending = deferred();
    const controller = createNetworkStatusController({
      source: 'test-native', getNativeStatus: () => pending.promise,
      startNative: async () => status(1), stopNative: async () => {}, listenNative: null,
    });
    const query = controller.getStatus();
    fire('lifeline:background');
    pending.resolve(status(8));
    const result = await query;
    assert.equal(result.availability, 'unknown');
    assert.equal(result.reason, 'background', 'a late getStatus reply after background is discarded');
  }

  {
    let revision = 0;
    const controller = createNetworkStatusController({
      source: 'test-native', getNativeStatus: async () => status(revision), listenNative: null,
      startNative: async () => status(++revision), stopNative: async () => {},
    });
    const cancelFirst = controller.subscribe(() => {});
    await tick();
    fire('lifeline:background');
    const afterBackground = [];
    const cancelSecond = controller.subscribe((value) => afterBackground.push(value));
    assert.equal(afterBackground[0].availability, 'unknown');
    assert.equal(afterBackground[0].reason, 'background', 'a new background subscriber never inherits foreground state');
    assert.equal(afterBackground[0].revision, 1, 'background invalidation preserves the last host revision');
    fire('lifeline:foreground');
    await tick();
    assert.equal(afterBackground.at(-1).availability, 'available', 'foreground re-registration obtains a fresh status');
    assert.equal(afterBackground.at(-1).revision, 2);
    cancelFirst();
    cancelSecond();
    await tick();
  }

  {
    let revision = 0;
    const controller = createNetworkStatusController({
      source: 'test-native', getNativeStatus: async () => status(revision), listenNative: null,
      startNative: async () => status(++revision), stopNative: async () => {},
    });
    const cancelFirst = controller.subscribe(() => {});
    await tick();
    cancelFirst();
    await tick();
    const nextGeneration = [];
    const cancelNext = controller.subscribe((value) => nextGeneration.push(value));
    assert.equal(nextGeneration[0].availability, 'unknown', 'a new subscription generation does not inherit a cancelled generation snapshot');
    await tick();
    assert.equal(nextGeneration.at(-1).revision, 2, 'host revision still orders new-generation native snapshots');
    cancelNext();
    await tick();
  }

  {
    const registration = deferred();
    let removed = 0; let starts = 0; const stops = [];
    const controller = createNetworkStatusController({
      source: 'test-native', getNativeStatus: async () => status(1),
      listenNative: async () => registration.promise,
      startNative: async () => { starts += 1; return status(1); },
      stopNative: async (token) => { stops.push(token); },
    });
    const cancel = controller.subscribe(() => {});
    await tick();
    cancel();
    registration.resolve({ remove: async () => { removed += 1; } });
    await tick();
    assert.equal(removed, 1, 'a listener handle delivered after cancellation is removed');
    assert.equal(starts, 0, 'cancelled registration does not start native monitoring');
    assert.equal(stops.length, 1, 'pending monitor token is cancelled immediately');
  }

  {
    const registration = deferred();
    let listens = 0; let removals = 0; const starts = [];
    const controller = createNetworkStatusController({
      source: 'test-native', getNativeStatus: async () => status(1),
      listenNative: async () => {
        listens += 1;
        if (listens === 1) return registration.promise;
        return { remove: async () => { removals += 1; } };
      },
      startNative: async (token) => { starts.push(token); return status(starts.length); },
      stopNative: async () => {},
    });
    const cancelFirst = controller.subscribe(() => {});
    await tick();
    cancelFirst();
    controller.subscribe(() => {});
    await tick();
    assert.equal(listens, 1, 'a second subscriber cannot register while the first listener handle is unresolved');
    registration.resolve({ remove: async () => { removals += 1; } });
    await tick();
    assert.equal(listens, 2, 'the next listener starts only after the late listener has been removed');
    assert.equal(removals, 1);
    assert.equal(starts.length, 1);
  }

  {
    const registration = deferred();
    let listens = 0; let removals = 0; let starts = 0;
    const controller = createNetworkStatusController({
      source: 'test-native', timeoutMs: 8, getNativeStatus: async () => status(1),
      listenNative: async () => {
        listens += 1;
        if (listens === 1) return registration.promise;
        return { remove: async () => { removals += 1; } };
      },
      startNative: async () => { starts += 1; return status(starts); },
      stopNative: async () => {},
    });
    const cancelFirst = controller.subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 25));
    cancelFirst();
    controller.subscribe(() => {});
    await tick();
    assert.equal(listens, 1, 'a replacement subscription waits while timed-out listener registration is unresolved');
    registration.resolve({ remove: async () => { removals += 1; } });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await tick();
    assert.equal(listens, 2, 'a replacement subscription can proceed after late timed-out registration cleanup');
    assert.equal(removals, 1);
    assert.equal(starts, 1);
  }

  {
    const starts = [];
    const stops = [];
    const callbacks = [];
    const controller = createNetworkStatusController({
      source: 'test-native', getNativeStatus: async () => status(10),
      listenNative: async (notify, token) => { callbacks.push({ notify, token }); return { remove: async () => {} }; },
      startNative: (token) => { const pending = deferred(); starts.push({ token, pending }); return pending.promise; },
      stopNative: async (token) => { stops.push(token); },
    });
    const seen = [];
    const cancelFirst = controller.subscribe((value) => seen.push(value));
    await tick();
    assert.equal(starts.length, 1);
    cancelFirst();
    const cancelSecond = controller.subscribe((value) => seen.push(value));
    await tick();
    assert.equal(starts.length, 2, 'new subscription can start while a cancelled older start is unresolved');
    starts[1].pending.resolve(status(2));
    await tick();
    starts[0].pending.resolve(status(99));
    await tick();
    assert.ok(stops.includes(starts[0].token), 'late old start only stops its own token');
    assert.ok(!stops.includes(starts[1].token), 'late old completion cannot stop the new subscription');
    const count = seen.length;
    callbacks[0].notify(status(100));
    assert.equal(seen.length, count, 'events from an old generation are ignored');
    cancelSecond();
  }

  {
    let starts = 0; let stopAttempts = 0; const seen = [];
    const controller = createNetworkStatusController({
      source: 'test-native', getNativeStatus: async () => status(4), listenNative: null,
      startNative: async () => { starts += 1; return status(starts); },
      stopNative: async () => { stopAttempts += 1; if (stopAttempts === 1) throw new Error('cleanup failed'); },
    });
    const cancel = controller.subscribe((value) => seen.push(value));
    await tick();
    cancel();
    await tick();
    const cancelAgain = controller.subscribe((value) => seen.push(value));
    await tick();
    assert.equal(stopAttempts, 2, 'failed cleanup is retried before registration can proceed');
    assert.equal(starts, 2);
    cancelAgain();
    await tick();
    assert.ok(!seen.some((item) => item.reason === 'registration'), 'a cleanup failure is not reported as a registration failure');
    assert.ok(seen.some((item) => item.revision === 2), 'synthetic error snapshots do not advance host revisions and block later native status');
  }

  {
    let starts = 0;
    const controller = createNetworkStatusController({
      source: 'test-native', getNativeStatus: async () => status(1), listenNative: null,
      startNative: async () => { starts += 1; return status(1); }, stopNative: async () => {},
    });
    let otherCalls = 0;
    controller.subscribe(() => { throw new Error('consumer failure'); });
    controller.subscribe(() => { otherCalls += 1; });
    await tick();
    assert.ok(otherCalls >= 2, 'one listener exception does not prevent other listeners');
    assert.equal(starts, 1, 'multiple JS subscribers share one native observer');
  }

  console.log('verify-network-status: PASS (query ordering, background replies, late registration, generation tokens, cleanup retry, revision isolation, shared subscribers)');
} finally {
  globalThis.addEventListener = originalAdd;
  globalThis.removeEventListener = originalRemove;
  if (originalActive === undefined) delete globalThis.__LIFELINE_APP_ACTIVE__;
  else globalThis.__LIFELINE_APP_ACTIVE__ = originalActive;
}
