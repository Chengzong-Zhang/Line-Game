import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMoveHapticsController } from '../src/haptics-controller.js';

function fakeClock() {
  let nextId = 0;
  const timers = new Map();
  return {
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fireAll() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } },
    get size() { return timers.size; },
    get latestDelay() { return [...timers.values()].at(-1)?.delay; },
  };
}

function storage(initial = null, { readError = false, writeError = false } = {}) {
  let value = initial;
  return {
    getItem() { if (readError) throw new Error('read failed'); return value; },
    setItem(_key, next) { if (writeError) throw new Error('write failed'); value = next; },
    get value() { return value; },
  };
}

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const i18nSource = await readFile(new URL('../../web/web前端/OnlineAppI18n.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../../web/web前端/OnlineApp.js', import.meta.url), 'utf8');
assert.equal((i18nSource.match(/moveHapticsNotice_read_error/g) ?? []).length, 0, 'stale underscore read-error keys are absent');
assert.equal((i18nSource.match(/"moveHapticsNotice_read-error"/g) ?? []).length, 2, 'both languages define the reachable read-error message');
assert.match(appSource, /role="switch"[^>]*:aria-label="getTexts\(language, uiStyle\)\.moveHapticsTitle"/, 'screen readers can identify the move-haptics switch when it is off');

const create = (options = {}) => createMoveHapticsController({
  storage: storage(),
  requestMoveHaptic: async () => ({ status: 'requested' }),
  ...options,
});

const absent = create({ storage: storage(null) });
assert.equal(absent.enabled, false, 'missing preference is off');
const corrupt = create({ storage: storage('true') });
assert.equal(corrupt.enabled, false, 'unknown preference values are off');
const unreadable = create({ storage: storage(null, { readError: true }) });
assert.equal(unreadable.enabled, false, 'preference read failure is off');
assert.equal(unreadable.preferenceState, 'read-error');

const openingStorage = storage(null, { writeError: true });
const cannotEnable = create({ storage: openingStorage });
assert.deepEqual(cannotEnable.setEnabled(true), { enabled: false, persisted: false, reason: 'storage-error' });
assert.equal(cannotEnable.enabled, false, 'failed opt-in cannot enable haptics');

const closingStorage = storage('1', { writeError: true });
const cannotRememberOff = create({ storage: closingStorage });
assert.equal(cannotRememberOff.enabled, true);
assert.deepEqual(cannotRememberOff.setEnabled(false), { enabled: false, persisted: false, reason: 'storage-error' });
assert.equal(cannotRememberOff.enabled, false, 'failed opt-out persistence still immediately disables this page');

const optedIn = create({ storage: storage(null) });
assert.deepEqual(optedIn.setEnabled(true), { enabled: true, persisted: true });
assert.equal(optedIn.enabled, true);
assert.equal(await optedIn.request(), 'requested');

for (const invalidReply of [null, undefined, {}, { status: 'unexpected' }]) {
  let calls = 0;
  const invalidController = create({ storage: storage('1'), requestMoveHaptic: async () => { calls += 1; return invalidReply; } });
  assert.equal(await invalidController.request(), 'unavailable', 'malformed settled native replies degrade gracefully');
  assert.equal(await invalidController.request(), 'unavailable', 'malformed replies release native occupancy');
  assert.equal(calls, 2);
}

const unavailable = create({ storage: storage('1'), requestMoveHaptic: undefined });
assert.equal(await unavailable.request(), 'unavailable');

const clock = fakeClock();
let finishNative;
const outcomes = [];
const pending = create({
  storage: storage('1'),
  setTimeoutFn: clock.setTimeout,
  clearTimeoutFn: clock.clearTimeout,
  timeoutMs: 250,
  onOutcome: (outcome) => outcomes.push(outcome),
  requestMoveHaptic: () => new Promise((resolve) => { finishNative = resolve; }),
});
const first = pending.request();
assert.equal(await pending.request(), 'busy');
assert.equal(clock.size, 1);
assert.equal(clock.latestDelay, 250);
pending.setActive(false);
assert.equal(await first, 'stale', 'background invalidates a pending native request');
finishNative({ status: 'requested' });
await flushMicrotasks();
pending.setActive(true);
const second = pending.request();
clock.fireAll();
assert.equal(await second, 'timeout', 'a stalled bridge is bounded by a timeout');
assert.equal(await pending.request(), 'busy', 'timeout does not release native occupancy or queue another request');
finishNative({ status: 'requested' });
await flushMicrotasks();
assert.deepEqual(outcomes, [], 'late completion after timeout does not notify UI');

let resolveReplacement;
const replaced = create({
  storage: storage('1'),
  requestMoveHaptic: () => new Promise((resolve) => { resolveReplacement = resolve; }),
});
const oldHostRequest = replaced.request();
await flushMicrotasks();
replaced.setHost({ id: 'replacement-controller' });
assert.equal(await oldHostRequest, 'stale', 'controller replacement invalidates the old host request');
resolveReplacement({ status: 'requested' });
await flushMicrotasks();

for (const invalidate of [
  (controller) => controller.dispose(),
  (controller) => controller.setEnabled(false),
  (controller) => controller.setActive(false),
]) {
  let calls = 0;
  const controller = create({ storage: storage('1'), requestMoveHaptic: async () => { calls += 1; return { status: 'requested' }; } });
  const notDispatched = controller.request();
  invalidate(controller);
  assert.equal(await notDispatched, 'stale');
  await flushMicrotasks();
  assert.equal(calls, 0, 'invalidation before dispatch never calls native');
}

let rejectNative;
const rejected = create({ storage: storage('1'), requestMoveHaptic: () => new Promise((_resolve, reject) => { rejectNative = reject; }) });
const rejectedRequest = rejected.request();
await flushMicrotasks();
rejectNative(new Error('permission denied'));
assert.equal(await rejectedRequest, 'error', 'native permission failure is bounded');

console.log('verify-move-haptics: PASS (default-off preference, storage failures, one in-flight request, timeout, lifecycle and host invalidation)');
