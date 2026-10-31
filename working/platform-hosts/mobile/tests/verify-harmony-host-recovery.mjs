import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from '../node_modules/typescript/lib/typescript.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'harmony/entry/src/main/ets/bridge/HostContentRecovery.ets');
const pagePath = path.join(root, 'harmony/entry/src/main/ets/pages/HostRecovery.ets');
const abilityPath = path.join(root, 'harmony/entry/src/main/ets/entryability/EntryAbility.ets');
const pagesPath = path.join(root, 'harmony/entry/src/main/resources/base/profile/main_pages.json');
const source = await readFile(sourcePath, 'utf8');
const pageSource = await readFile(pagePath, 'utf8');
const abilitySource = await readFile(abilityPath, 'utf8');
const pages = JSON.parse(await readFile(pagesPath, 'utf8'));
const code = ts.transpileModule(source.replace(/^import .*;\r?\n/gm, '').replace('export const', 'const'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText + '\nglobalThis.recovery = hostContentRecovery;';

function makeStage({ throwPages = {}, holdCallbacks = false } = {}) {
  const calls = [];
  const callbacks = [];
  return {
    calls,
    callbacks,
    loadContent(page, callback) {
      calls.push(page);
      if (throwPages[page]) throw new Error(`sync ${page}`);
      if (holdCallbacks) callbacks.push({ page, callback });
      else callback({ code: 0, message: '' });
    },
  };
}

function makeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const cleared = [];

  function setTimeout(callback, delay) {
    const id = nextId++;
    timers.set(id, { at: now + Number(delay), callback });
    return id;
  }

  function clearTimeout(id) {
    if (timers.delete(id)) cleared.push(id);
  }

  function advance(milliseconds) {
    const target = now + milliseconds;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      now = timer.at;
      timer.callback();
    }
    now = target;
  }

  return {
    setTimeout,
    clearTimeout,
    advance,
    pendingCount: () => timers.size,
    pendingIds: () => [...timers.keys()],
    cleared,
  };
}

function makeRecovery() {
  const errors = [];
  const clock = makeClock();
  const context = vm.createContext({
    console: { error: (message) => errors.push(message) },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  vm.runInContext(code, context);
  return { recovery: context.recovery, errors, clock };
}

const failedMain = makeRecovery();
const mainStage = makeStage({ holdCallbacks: true });
failedMain.recovery.start(mainStage);
failedMain.recovery.start(mainStage);
assert.deepEqual(mainStage.calls, ['pages/Index'], 'repeated start for the same stage is idempotent');
assert.deepEqual(mainStage.calls, ['pages/Index']);
assert.equal(failedMain.recovery.retryMainPage(), false, 'pending startup load cannot be duplicated');
mainStage.callbacks.shift().callback({ code: 1001, message: 'missing main page' });
assert.deepEqual(mainStage.calls, ['pages/Index', 'pages/HostRecovery'], 'main callback failure loads one recovery page');
assert.equal(failedMain.recovery.isPending(), true, 'recovery page load is included in the same single-flight gate');
assert.equal(failedMain.recovery.retryMainPage(), false, 'cannot race retry against recovery-page loading');
const observedStates = [];
const observerId = failedMain.recovery.subscribe(() => observedStates.push(failedMain.recovery.isPending()));
observedStates.push(failedMain.recovery.isPending()); // HostRecovery.aboutToAppear reads state before subscribing.
const fallbackWatchdogId = failedMain.clock.pendingIds()[0];
mainStage.callbacks.shift().callback({ code: 0, message: '' });
assert.equal(failedMain.recovery.isPending(), false);
assert.ok(failedMain.clock.cleared.includes(fallbackWatchdogId), 'fallback completion cancels its watchdog before retry');
assert.equal(failedMain.clock.pendingCount(), 0);
assert.match(failedMain.recovery.message(), /主页面加载失败/);
assert.equal(observedStates.at(-1), false, 'recovery success callback enables the visible retry button');
assert.equal(failedMain.recovery.retryMainPage(), true, 'retry becomes available after fallback success');
assert.equal(failedMain.clock.pendingCount(), 1, 'retry starts with only its own watchdog');
assert.equal(observedStates.at(-1), true, 'retry pending transition reaches the visible recovery page');
assert.equal(failedMain.recovery.retryMainPage(), false, 'rapid retry taps remain single-flight');
mainStage.callbacks.shift().callback({ code: 0, message: '' });
assert.equal(observedStates.at(-1), false, 'retry completion updates the visible recovery page');
assert.equal(failedMain.clock.pendingCount(), 0, 'retry completion cancels its watchdog');
failedMain.recovery.unsubscribe(observerId);

const brokenObserver = makeRecovery();
const brokenObserverStage = makeStage({ holdCallbacks: true });
let brokenObserverCalls = 0;
const healthyObserverStates = [];
brokenObserver.recovery.subscribe(() => {
  brokenObserverCalls += 1;
  throw new Error('stale UI observer');
});
brokenObserver.recovery.subscribe(() => healthyObserverStates.push(brokenObserver.recovery.isPending()));
assert.doesNotThrow(() => brokenObserver.recovery.start(brokenObserverStage), 'a failed observer cannot escape start or lock loading before stage.loadContent');
assert.deepEqual(brokenObserverStage.calls, ['pages/Index']);
assert.equal(brokenObserver.recovery.isPending(), true);
brokenObserverStage.callbacks.shift().callback({ code: 1002, message: 'retryable' });
assert.deepEqual(brokenObserverStage.calls, ['pages/Index', 'pages/HostRecovery']);
assert.equal(brokenObserverCalls, 1, 'a throwing observer is isolated and removed');
assert.deepEqual(healthyObserverStates, [true, false, true], 'other observers receive start, main failure and fallback pending transitions');
brokenObserverStage.callbacks.shift().callback({ code: 0, message: '' });
assert.equal(healthyObserverStates.at(-1), false, 'healthy observer receives fallback completion');
assert.equal(brokenObserver.recovery.retryMainPage(), true, 'real recovery retry remains callable after observer failure');
assert.deepEqual(healthyObserverStates.slice(-1), [true]);
brokenObserverStage.callbacks.shift().callback({ code: 0, message: '' });
assert.deepEqual(healthyObserverStates.slice(-1), [false]);

const retry = makeRecovery();
const retryStage = makeStage({ holdCallbacks: true });
retry.recovery.start(retryStage);
retryStage.callbacks.shift().callback({ code: 0, message: '' });
assert.equal(retry.recovery.retryMainPage(), true);
assert.equal(retry.recovery.retryMainPage(), false, 'rapid repeated taps do not create concurrent loads');
assert.deepEqual(retryStage.calls, ['pages/Index', 'pages/Index']);
retryStage.callbacks.shift().callback({ code: 0, message: '' });
assert.equal(retry.recovery.isPending(), false);

const staleRequest = makeRecovery();
const staleRequestStage = makeStage({ holdCallbacks: true });
staleRequest.recovery.start(staleRequestStage);
const completedRequest = staleRequestStage.callbacks.shift().callback;
completedRequest({ code: 0, message: '' });
staleRequest.recovery.retryMainPage();
completedRequest({ code: 1009, message: 'duplicate callback' });
assert.deepEqual(staleRequestStage.calls, ['pages/Index', 'pages/Index'], 'duplicate callback from an older request cannot start fallback');
assert.equal(staleRequest.recovery.isPending(), true, 'older request callback cannot settle the current load');
staleRequestStage.callbacks.shift().callback({ code: 0, message: '' });
assert.equal(staleRequest.recovery.isPending(), false);

const syncFailure = makeRecovery();
const syncStage = makeStage({ throwPages: { 'pages/Index': true } });
syncFailure.recovery.start(syncStage);
assert.deepEqual(syncStage.calls, ['pages/Index', 'pages/HostRecovery'], 'synchronous main-page throw reaches one fallback');
assert.match(syncFailure.recovery.message(), /主页面加载失败/);

const failedFallback = makeRecovery();
const fallbackStage = makeStage({ throwPages: { 'pages/Index': true, 'pages/HostRecovery': true } });
failedFallback.recovery.start(fallbackStage);
assert.deepEqual(fallbackStage.calls, ['pages/Index', 'pages/HostRecovery'], 'fallback failure never recursively loads fallback');
assert.equal(failedFallback.errors.length, 1);
assert.equal(failedFallback.recovery.isPending(), false);

const mainTimeout = makeRecovery();
const mainTimeoutStage = makeStage({ holdCallbacks: true });
mainTimeout.recovery.start(mainTimeoutStage);
assert.equal(mainTimeout.clock.pendingCount(), 1, 'main-page load owns one watchdog');
const lateTimedOutMain = mainTimeoutStage.callbacks.shift().callback;
mainTimeout.clock.advance(14_999);
assert.deepEqual(mainTimeoutStage.calls, ['pages/Index'], 'main page remains pending before the bounded deadline');
mainTimeout.clock.advance(1);
assert.deepEqual(mainTimeoutStage.calls, ['pages/Index', 'pages/HostRecovery'], 'main watchdog opens the existing recovery page exactly once');
assert.equal(mainTimeout.recovery.isPending(), true, 'fallback load owns the single-flight gate after a main timeout');
assert.match(mainTimeout.recovery.message(), /主页面加载超时/);
assert.equal(mainTimeout.clock.pendingCount(), 1, 'main watchdog is replaced by one fallback watchdog');
lateTimedOutMain({ code: 1008, message: 'late main failure' });
assert.deepEqual(mainTimeoutStage.calls, ['pages/Index', 'pages/HostRecovery'], 'late main callback cannot repeat fallback navigation');
assert.match(mainTimeout.recovery.message(), /主页面加载超时/, 'late main callback cannot replace timeout state');
mainTimeoutStage.callbacks.shift().callback({ code: 0, message: '' });
assert.equal(mainTimeout.recovery.isPending(), false);
assert.equal(mainTimeout.clock.pendingCount(), 0, 'fallback callback cancels its watchdog');

const fallbackTimeout = makeRecovery();
const fallbackTimeoutStage = makeStage({ holdCallbacks: true });
fallbackTimeout.recovery.start(fallbackTimeoutStage);
const initialMainCallback = fallbackTimeoutStage.callbacks.shift().callback;
const initialWatchdogId = fallbackTimeout.clock.pendingIds()[0];
initialMainCallback({ code: 1009, message: 'main unavailable' });
assert.ok(fallbackTimeout.clock.cleared.includes(initialWatchdogId), 'main callback cancels its old watchdog before fallback');
const lateTimedOutFallback = fallbackTimeoutStage.callbacks.shift().callback;
fallbackTimeout.clock.advance(9_999);
assert.equal(fallbackTimeout.recovery.isPending(), true, 'fallback remains pending before its bounded deadline');
fallbackTimeout.clock.advance(1);
assert.equal(fallbackTimeout.recovery.isPending(), false, 'fallback timeout terminates the pending request');
assert.match(fallbackTimeout.recovery.message(), /恢复页面加载超时/);
assert.match(fallbackTimeout.recovery.message(), /本次启动已结束/, 'fallback timeout exposes a terminal attempt state');
assert.equal(fallbackTimeout.clock.pendingCount(), 0);
assert.equal(fallbackTimeout.errors.length, 1, 'fallback timeout is logged once');
assert.equal(fallbackTimeout.recovery.retryMainPage(), true, 'terminal fallback timeout permits an explicit retry');
assert.deepEqual(fallbackTimeoutStage.calls, ['pages/Index', 'pages/HostRecovery', 'pages/Index']);
assert.equal(fallbackTimeout.clock.pendingCount(), 1, 'retry owns only its new watchdog');
lateTimedOutFallback({ code: 0, message: '' });
assert.equal(fallbackTimeout.recovery.isPending(), true, 'late fallback callback cannot settle the retry');
assert.match(fallbackTimeout.recovery.message(), /恢复页面加载超时/, 'late fallback callback cannot overwrite the visible failure');
fallbackTimeoutStage.callbacks.shift().callback({ code: 0, message: '' });
assert.equal(fallbackTimeout.recovery.isPending(), false);
assert.equal(fallbackTimeout.recovery.message(), '', 'successful retry clears the terminal timeout message');
assert.equal(fallbackTimeout.clock.pendingCount(), 0, 'successful retry cancels its watchdog');

const replacedStage = makeRecovery();
const firstGenerationStage = makeStage({ holdCallbacks: true });
const secondGenerationStage = makeStage({ holdCallbacks: true });
replacedStage.recovery.start(firstGenerationStage);
const firstGenerationCallback = firstGenerationStage.callbacks.shift().callback;
const firstGenerationTimer = replacedStage.clock.pendingIds()[0];
replacedStage.recovery.start(secondGenerationStage);
assert.ok(replacedStage.clock.cleared.includes(firstGenerationTimer), 'a new stage cancels the prior generation watchdog');
assert.equal(replacedStage.clock.pendingCount(), 1, 'new generation owns one watchdog');
firstGenerationCallback({ code: 1010, message: 'late old-stage failure' });
assert.deepEqual(firstGenerationStage.calls, ['pages/Index'], 'old generation callback cannot navigate its stage');
assert.equal(replacedStage.recovery.isPending(), true, 'old generation callback cannot settle the new stage');
secondGenerationStage.callbacks.shift().callback({ code: 0, message: '' });
assert.equal(replacedStage.clock.pendingCount(), 0);

const stale = makeRecovery();
const staleStage = makeStage({ holdCallbacks: true });
stale.recovery.start(staleStage);
const oldCallback = staleStage.callbacks.shift().callback;
const destroyedTimer = stale.clock.pendingIds()[0];
stale.recovery.destroyStage();
assert.ok(stale.clock.cleared.includes(destroyedTimer), 'stage destruction cancels the active watchdog');
assert.equal(stale.clock.pendingCount(), 0);
oldCallback({ code: 101, message: 'late failure' });
assert.deepEqual(staleStage.calls, ['pages/Index'], 'old-stage callback cannot load a recovery page after destruction');
const currentStage = makeStage();
stale.recovery.start(currentStage);
assert.deepEqual(currentStage.calls, ['pages/Index'], 'a newly created stage can load the main page');

assert.deepEqual(pages.src, ['pages/Index', 'pages/HostRecovery']);
assert.match(pageSource, /Button\(this\.pending \? '正在加载…' : '重试打开'\)/);
assert.match(pageSource, /Text\(this\.failureMessage\)/, 'terminal watchdog state is bound to visible recovery-page text');
assert.match(pageSource, /无法取消/);
assert.match(abilitySource, /onWindowStageDestroy\(\)[\s\S]*destroyStage\(\)/);
assert.match(source, /stage\.loadContent\(MAIN_PAGE/);
assert.match(source, /stage\.loadContent\(RECOVERY_PAGE/);
console.log('verify-harmony-host-recovery: PASS (callback, sync and bounded-timeout failures; fallback-once, watchdog cancellation, retry, stage teardown and stale callback isolation; no Harmony SDK compilation)');

const policyPath = path.join(root, 'harmony/entry/src/main/ets/bridge/MainWebRecoveryPolicy.ets');
const policySource = await readFile(policyPath, 'utf8');
const policyCode = ts.transpileModule(policySource.replace(/^export type .*;\r?\n/m, '').replace('export class', 'class'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText + '\nglobalThis.Policy = MainWebRecoveryPolicy;';
const policyContext = vm.createContext({});
vm.runInContext(policyCode, policyContext);
const policy = new policyContext.Policy();
assert.equal(policy.beginAutomaticRecovery(0), 'recover', 'the first main renderer/load failure permits one automatic replacement');
assert.equal(policy.isCurrent(0), false, 'the failed page generation is revoked before its replacement loads');
assert.equal(policy.beginAutomaticRecovery(1), 'exhausted', 'a second failure stops automatic recovery');
assert.equal(policy.beginManualRetry(2), 3, 'manual retry creates a fresh isolated generation');
assert.equal(policy.beginAutomaticRecovery(3), 'exhausted', 'a failed manual retry does not re-enable automatic recovery');
assert.equal(policy.beginManualRetry(4), 5, 'a failed manual retry still permits another explicit retry');
assert.equal(policy.beginAutomaticRecovery(3), 'stale', 'callbacks from the prior retry generation cannot recover the current page');
assert.equal(policy.shouldRecoverHttpError(true, 400), true, 'main-frame client errors enter recovery');
assert.equal(policy.shouldRecoverHttpError(true, 599), true, 'main-frame server errors enter recovery');
assert.equal(policy.shouldRecoverHttpError(false, 500), false, 'subresource HTTP failures do not replace the main page');
assert.equal(policy.shouldRecoverHttpError(true, 399), false, 'non-error redirects/success responses do not trigger recovery');
assert.equal(policy.shouldRecoverHttpError(true, 600), false, 'out-of-range status codes do not trigger HTTP recovery');
console.log('verify-harmony-host-recovery: PASS (runtime recovery policy: single automatic attempt, stale generation isolation, repeated manual retry)');
