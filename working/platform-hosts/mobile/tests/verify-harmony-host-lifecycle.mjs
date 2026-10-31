import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from '../node_modules/typescript/lib/typescript.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pagePath = path.join(root, 'harmony/entry/src/main/ets/pages/Index.ets');
const registryPath = path.join(root, 'harmony/entry/src/main/ets/bridge/WebControllerRegistry.ets');
const pageSource = await readFile(pagePath, 'utf8');
const registrySource = await readFile(registryPath, 'utf8');
const stripImports = source => source.replace(/^import .*;\r?\n/gm, '');
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const pageCut = pageSource.indexOf('  private createResponse(');
assert.ok(pageCut > 0, 'host startup methods remain ahead of ArkUI resource/rendering methods');
const pageCode = stripImports(pageSource.slice(0, pageCut))
  .replace(/^@(Entry|Component)\s*$/gm, '')
  .replace(/@State\s+/g, '')
  .replace('struct Index', 'class Index') + '}\nglobalThis.Page = Index;';
const registryCode = stripImports(registrySource)
  .replace('export class', 'class') + '\nglobalThis.Registry = WebControllerRegistry;';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function drain() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function setup(getPreferences, { moveAbilityToBackground = async () => {} } = {}) {
  const calls = [];
  const errors = [];
  const backgroundCalls = [];
  const timers = new Map();
  let networkStopCalls = 0;
  let nextTimer = 0;
  class Controller {
    constructor(result = Promise.resolve(''), synchronousError = null) {
      this.result = result;
      this.synchronousError = synchronousError;
    }
    getUrl() { return 'https://lifeline.appassets.invalid/'; }
    accessBackward() { return false; }
    backward() {}
    runJavaScript(script) {
      calls.push({ controller: this, script });
      if (this.synchronousError !== null) throw this.synchronousError;
      return this.result;
    }
  }
  const context = vm.createContext({
    preferences: { getPreferences },
    webview: { WebviewController: Controller },
    NetworkStatusMonitor: { stop() { networkStopCalls += 1; return Promise.resolve(); } },
    MainWebRecoveryPolicy: class {
      generation() { return 0; }
      isCurrent(generation) { return generation === 0; }
      beginAutomaticRecovery() { return 'recover'; }
      beginManualRetry(generation) { return generation + 1; }
      shouldRecoverHttpError(isMainFrame, statusCode) { return isMainFrame && statusCode >= 400 && statusCode <= 599; }
    },
    url: { URL },
    cryptoFramework: { createRandom() { return { generateRandomSync(length) { return { data: randomBytes(length) }; } }; } },
    LifelineNativeProxy: class { constructor(store, controller, host) { this.store = store; this.controller = controller; this.host = host; } },
    common: {}, PACKAGED_WEB_FILES: [],
    console: { error(message) { errors.push(message); }, info() {}, warn() {} },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(transpile(registryCode), context);
  vm.runInContext(transpile(pageCode), context);
  const page = new context.Page();
  const hostContext = {
    host: 'synthetic',
    async moveAbilityToBackground() {
      backgroundCalls.push('moveAbilityToBackground');
      return moveAbilityToBackground();
    },
  };
  page.getUIContext = () => ({ getHostContext: () => hostContext });
  return {
    context, page, calls, errors, timers, Controller, backgroundCalls, hostContext,
    get networkStopCalls() { return networkStopCalls; },
    registry: context.Registry,
    fireWatchdog() {
      const timer = [...timers.values()][0];
      assert.ok(timer, 'startup watchdog is scheduled while Preferences is pending');
      timer.callback();
      timers.clear();
    },
  };
}

const pending = deferred();
let getCount = 0;
const startup = setup(() => { getCount += 1; return pending.promise; });
startup.page.aboutToAppear();
await drain();
assert.equal(getCount, 1, 'page startup starts one Preferences request');
startup.fireWatchdog();
assert.equal(startup.page.startupPhase, 'waiting');
assert.match(startup.page.startupMessage, /仍在等待/);
startup.page.retryHostInitialization();
await drain();
assert.equal(getCount, 1, 'a pending request cannot be retried concurrently');
assert.equal(startup.page.ready, false, 'watchdog never treats a timeout as Preferences success');
pending.resolve({ store: 'late but current' });
await drain();
assert.equal(startup.page.ready, true, 'a still-mounted page accepts its own late success');
assert.equal(startup.page.nativeProxy.store.store, 'late but current');

let retryCount = 0;
const retryResult = deferred();
const retrying = setup(() => {
  retryCount += 1;
  return retryCount === 1 ? Promise.reject(new Error('denied')) : retryResult.promise;
});
retrying.page.aboutToAppear();
await drain();
assert.equal(retrying.page.startupPhase, 'failed');
assert.match(retrying.page.startupMessage, /本地存档初始化失败/);
assert.match(pageSource, /Button\('重试初始化'\)/, 'failure UI exposes an explicit retry button');
assert.doesNotMatch(pageSource, /权限/, 'startup guidance does not assume a runtime permission is missing');
retrying.page.retryHostInitialization();
await drain();
assert.equal(retryCount, 2, 'a settled rejection can start exactly one retry');
retryResult.resolve({ store: 'recovered' });
await drain();
assert.equal(retrying.page.ready, true);

const staleSuccess = deferred();
const staleSuccessHost = setup(() => staleSuccess.promise);
staleSuccessHost.page.aboutToAppear();
await drain();
staleSuccessHost.page.aboutToDisappear();
assert.equal(staleSuccessHost.networkStopCalls, 1, 'page disappearance requests network monitor cleanup');
const stateBeforeStaleSuccess = [staleSuccessHost.page.ready, staleSuccessHost.page.startupPhase, staleSuccessHost.page.startupMessage];
staleSuccess.resolve({ store: 'stale' });
await drain();
assert.deepEqual([staleSuccessHost.page.ready, staleSuccessHost.page.startupPhase, staleSuccessHost.page.startupMessage], stateBeforeStaleSuccess,
  'late success after disappearance cannot change page state or create the native proxy');
assert.equal(staleSuccessHost.page.nativeProxy, null);

const beforeReappear = deferred();
let reappearCalls = 0;
const reappearingHost = setup(() => {
  reappearCalls += 1;
  return reappearCalls === 1 ? beforeReappear.promise : Promise.resolve({ store: 'new generation' });
});
reappearingHost.page.aboutToAppear();
await drain();
reappearingHost.page.aboutToDisappear();
reappearingHost.page.aboutToAppear();
await drain();
assert.equal(reappearCalls, 1, 'reappearing while the previous request is pending does not overlap Preferences calls');
assert.equal(reappearingHost.page.startupPhase, 'waiting');
beforeReappear.resolve({ store: 'old generation' });
await drain();
assert.equal(reappearCalls, 2, 'the new page generation starts initialization only after the old request settles');
assert.equal(reappearingHost.page.ready, true);
assert.equal(reappearingHost.page.nativeProxy.store.store, 'new generation', 'the stale request result is not adopted');

const rejectedBeforeReappear = deferred();
let rejectedReappearCalls = 0;
const rejectedReappearingHost = setup(() => {
  rejectedReappearCalls += 1;
  return rejectedReappearCalls === 1 ? rejectedBeforeReappear.promise : Promise.resolve({ store: 'after old rejection' });
});
rejectedReappearingHost.page.aboutToAppear();
await drain();
rejectedReappearingHost.page.aboutToDisappear();
rejectedReappearingHost.page.aboutToAppear();
rejectedBeforeReappear.reject(new Error('obsolete rejection'));
await drain();
assert.equal(rejectedReappearCalls, 2, 'a new generation retries only after the obsolete rejection settles');
assert.equal(rejectedReappearingHost.page.ready, true);
assert.equal(rejectedReappearingHost.page.startupPhase, 'ready', 'an obsolete error cannot replace the new generation result');

const staleError = deferred();
const staleErrorHost = setup(() => staleError.promise);
staleErrorHost.page.aboutToAppear();
await drain();
staleErrorHost.page.aboutToDisappear();
const stateBeforeStaleError = [staleErrorHost.page.ready, staleErrorHost.page.startupPhase, staleErrorHost.page.startupMessage];
staleError.reject(new Error('late rejection'));
await drain();
assert.deepEqual([staleErrorHost.page.ready, staleErrorHost.page.startupPhase, staleErrorHost.page.startupMessage], stateBeforeStaleError,
  'late rejection and finally after disappearance cannot overwrite page state');

const registry = startup.registry;
const firstController = new startup.Controller();
const secondController = new startup.Controller();
registry.dispatchLifecycle('lifeline:background');
registry.attach(firstController);
assert.equal(startup.calls.length, 0, 'lifecycle state is retained without dispatch before Web readiness');
registry.markReady(firstController);
assert.equal(startup.calls.length, 1);
assert.match(startup.calls[0].script, /lifeline:background/);
assert.match(startup.calls[0].script, /__LIFELINE_APP_ACTIVE__=false/,
  'Harmony injects the retained lifecycle state before notifying listeners that may not yet exist');
registry.attach(secondController);
registry.markReady(secondController);
const firstCallCount = startup.calls.filter(call => call.controller === firstController).length;
registry.detach(firstController);
registry.dispatchLifecycle('lifeline:foreground');
assert.match(startup.calls.at(-1).script, /__LIFELINE_APP_ACTIVE__=true/,
  'Harmony foreground injection updates the initial-state snapshot before dispatch');
assert.equal(startup.calls.filter(call => call.controller === secondController).length, 2,
  'detaching an old page cannot detach the currently registered controller');
assert.equal(startup.calls.filter(call => call.controller === firstController).length, firstCallCount);
registry.detach(secondController);
registry.dispatchLifecycle('lifeline:background');
assert.equal(startup.calls.length, 3, 'no JavaScript is sent after the current page detaches');

const synchronousFailure = new startup.Controller(Promise.resolve(''), new Error('not attached'));
registry.attach(synchronousFailure);
assert.doesNotThrow(() => registry.markReady(synchronousFailure), 'synchronous WebView errors are contained');
const recoveredAfterSynchronousFailure = {
  calls: 0,
  runJavaScript() {
    this.calls += 1;
    if (this.calls === 1) throw new Error('one-time synchronous failure');
    return Promise.resolve('');
  },
};
registry.attach(recoveredAfterSynchronousFailure);
registry.markReady(recoveredAfterSynchronousFailure);
registry.dispatchLifecycle('lifeline:foreground');
assert.equal(recoveredAfterSynchronousFailure.calls, 2,
  'a later real lifecycle event retries after a synchronous failure without navigation');
registry.dispatchLifecycle('lifeline:foreground');
assert.equal(recoveredAfterSynchronousFailure.calls, 3, 'the currently ready page remains eligible for later lifecycle dispatch');
assert.ok(startup.errors.some(message => message.includes('not attached')));

const asyncFailure = new startup.Controller(Promise.reject(new Error('asynchronous failure')));
registry.attach(asyncFailure);
registry.markReady(asyncFailure);
await drain();
const afterAsyncFailure = startup.calls.length;
const recoveredAfterAsyncFailure = {
  calls: 0,
  runJavaScript() {
    this.calls += 1;
    return this.calls === 1 ? Promise.reject(new Error('one-time async failure')) : Promise.resolve('');
  },
};
registry.attach(recoveredAfterAsyncFailure);
registry.markReady(recoveredAfterAsyncFailure);
await drain();
registry.dispatchLifecycle('lifeline:foreground');
assert.equal(recoveredAfterAsyncFailure.calls, 2,
  'a later real lifecycle event retries after an asynchronous failure without navigation');
registry.dispatchLifecycle('lifeline:background');
assert.equal(recoveredAfterAsyncFailure.calls, 3, 'the ready page remains eligible after asynchronous rejection');
assert.ok(startup.errors.some(message => message.includes('asynchronous failure')));

const delayedReject = deferred();
let delayedCallCount = 0;
const sameController = {
  runJavaScript() {
    delayedCallCount += 1;
    return delayedCallCount === 1 ? delayedReject.promise : Promise.resolve('');
  },
};
registry.attach(sameController);
registry.markReady(sameController);
registry.markLoading(sameController);
registry.markReady(sameController);
delayedReject.reject(new Error('obsolete lifecycle call'));
await drain();
registry.dispatchLifecycle('lifeline:background');
assert.equal(delayedCallCount, 3,
  'an old dispatch rejection cannot revoke readiness after a newer same-controller page load and dispatch');
assert.equal(startup.errors.some(message => message.includes('obsolete lifecycle call')), false,
  'stale dispatch failures are ignored after a newer readiness generation');

const backgroundBeforeDetach = { calls: 0, runJavaScript(script) { this.calls += 1; this.script = script; return Promise.resolve(''); } };
const replacementAfterDetach = { calls: 0, runJavaScript(script) { this.calls += 1; this.script = script; return Promise.resolve(''); } };
registry.attach(backgroundBeforeDetach);
registry.dispatchLifecycle('lifeline:background');
registry.markReady(backgroundBeforeDetach);
assert.equal(backgroundBeforeDetach.calls, 1);
registry.detach(backgroundBeforeDetach);
registry.attach(replacementAfterDetach);
assert.equal(replacementAfterDetach.calls, 0, 'known ability state is not dispatched before the replacement Web page is ready');
registry.markReady(replacementAfterDetach);
assert.equal(replacementAfterDetach.calls, 1, 'the latest ability state is replayed to a replacement page without a new OS event');
assert.match(replacementAfterDetach.script, /lifeline:background/);

assert.doesNotMatch(registrySource, /\.replace\(\s*\/[^\r\n]*\//,
  'ArkTS source normalization must not reintroduce RegExp literal syntax');
for (const [value, expectedUnhandled] of [
  ['true', false], ['false', true], ["'true'", false], ['"true"', false], ["'false'", true], ['"false"', true],
]) {
  const controller = new startup.Controller(Promise.resolve(value));
  let unhandled = 0;
  registry.attach(controller);
  registry.markReady(controller);
  assert.equal(registry.dispatchBack(controller, () => { unhandled += 1; }), true,
    'a ready controller accepts its back request');
  await drain();
  assert.equal(unhandled > 0, expectedUnhandled, `back result ${JSON.stringify(value)} preserves handled/unhandled semantics`);
  registry.detach(controller);
}

function readyBackHost(result = Promise.resolve('true'), options = {}) {
  const host = setup(() => Promise.resolve({ store: 'back-test' }), options);
  host.page.active = true;
  host.page.ready = true;
  host.page.hostContext = host.hostContext;
  host.page.controller = new host.Controller(result);
  host.registry.attach(host.page.controller);
  host.registry.markReady(host.page.controller);
  return host;
}

const tutorialBack = readyBackHost();
tutorialBack.page.tutorialUrl = 'https://lifeline.appassets.invalid/index.html?tutorial=1';
assert.equal(tutorialBack.page.onBackPress(), true, 'tutorial overlay consumes the page back event');
assert.equal(tutorialBack.page.tutorialUrl, '', 'tutorial overlay closes through Index.onBackPress');
assert.equal(tutorialBack.calls.length, 0, 'tutorial close does not dispatch back to the main Web page');
assert.equal(tutorialBack.backgroundCalls.length, 0, 'tutorial close keeps the ability in the foreground');

const webHandledBack = readyBackHost(Promise.resolve('true'));
assert.equal(webHandledBack.page.onBackPress(), true, 'active page consumes the native back callback while handling is pending');
assert.equal(webHandledBack.calls.length, 1, 'Index.onBackPress reaches Registry.dispatchBack and WebviewController.runJavaScript');
assert.match(webHandledBack.calls[0].script, /lifeline:back/);
await drain();
assert.equal(webHandledBack.backgroundCalls.length, 0, 'Web-handled back leaves the ability in the foreground');

const webUnhandledBack = readyBackHost(Promise.resolve('false'));
webUnhandledBack.page.onBackPress();
await drain();
assert.equal(webUnhandledBack.backgroundCalls.length, 1, 'Web-unhandled back requests moveAbilityToBackground');

const webDispatchFailure = readyBackHost(Promise.reject(new Error('JavaScript bridge failed')));
webDispatchFailure.page.onBackPress();
await drain();
assert.equal(webDispatchFailure.backgroundCalls.length, 1, 'a rejected Web back dispatch falls through to the host background request');

const notReadyBack = setup(() => Promise.resolve({ store: 'not-ready' }));
notReadyBack.page.active = true;
notReadyBack.page.hostContext = notReadyBack.hostContext;
notReadyBack.page.ready = false;
assert.equal(notReadyBack.page.onBackPress(), true, 'active Index handles back before Web readiness');
await drain();
assert.equal(notReadyBack.calls.length, 0, 'Web-not-ready back does not dispatch JavaScript');
assert.equal(notReadyBack.backgroundCalls.length, 1, 'Web-not-ready back directly requests moveAbilityToBackground');

const notReadyBackgroundTransition = deferred();
const notReadyRepeated = setup(() => Promise.resolve({ store: 'not-ready-repeated' }), {
  moveAbilityToBackground: () => notReadyBackgroundTransition.promise,
});
notReadyRepeated.page.active = true;
notReadyRepeated.page.hostContext = notReadyRepeated.hostContext;
notReadyRepeated.page.ready = false;
notReadyRepeated.page.onBackPress();
notReadyRepeated.page.onBackPress();
assert.equal(notReadyRepeated.backgroundCalls.length, 1, 'repeated back while Web is not ready shares the pending ability transition');
assert.equal(notReadyRepeated.calls.length, 0, 'repeated Web-not-ready back never dispatches Web JavaScript');
notReadyRepeated.page.tutorialUrl = 'https://lifeline.appassets.invalid/index.html?tutorial=1';
assert.equal(notReadyRepeated.page.onBackPress(), true, 'tutorial dismissal retains priority during a pending background transition');
assert.equal(notReadyRepeated.page.tutorialUrl, '', 'tutorial closes while the background transition is pending');
assert.equal(notReadyRepeated.backgroundCalls.length, 1);
notReadyBackgroundTransition.resolve();
await drain();

const registryNotReadyBack = setup(() => Promise.resolve({ store: 'registry-not-ready' }));
registryNotReadyBack.page.active = true;
registryNotReadyBack.page.ready = true;
registryNotReadyBack.page.hostContext = registryNotReadyBack.hostContext;
assert.equal(registryNotReadyBack.page.onBackPress(), true, 'Index consumes back when the Web registry cannot dispatch');
await drain();
assert.equal(registryNotReadyBack.calls.length, 0);
assert.equal(registryNotReadyBack.backgroundCalls.length, 1, 'a false Registry.dispatchBack result requests background');

const registryBackgroundTransition = deferred();
const registryRepeated = setup(() => Promise.resolve({ store: 'registry-repeated' }), {
  moveAbilityToBackground: () => registryBackgroundTransition.promise,
});
registryRepeated.page.active = true;
registryRepeated.page.ready = true;
registryRepeated.page.hostContext = registryRepeated.hostContext;
registryRepeated.page.onBackPress();
registryRepeated.page.onBackPress();
assert.equal(registryRepeated.calls.length, 0, 'Registry false path does not dispatch JavaScript');
assert.equal(registryRepeated.backgroundCalls.length, 1, 'repeated back after Registry false shares the pending ability transition');
registryBackgroundTransition.resolve();
await drain();

const unhandledBackgroundTransition = deferred();
const unhandledRepeated = readyBackHost(Promise.resolve('false'), {
  moveAbilityToBackground: () => unhandledBackgroundTransition.promise,
});
unhandledRepeated.page.onBackPress();
await drain();
assert.equal(unhandledRepeated.calls.length, 1, 'first Web-unhandled back dispatches once');
assert.equal(unhandledRepeated.backgroundCalls.length, 1, 'Web-unhandled result starts one pending ability transition');
unhandledRepeated.page.onBackPress();
await drain();
assert.equal(unhandledRepeated.calls.length, 1, 'repeated back during background transition does not dispatch Web again');
assert.equal(unhandledRepeated.backgroundCalls.length, 1, 'repeated Web-unhandled back does not request background twice');
unhandledBackgroundTransition.resolve();
await drain();

const inactiveBack = readyBackHost();
inactiveBack.page.active = false;
assert.equal(inactiveBack.page.onBackPress(), false, 'inactive Index declines the back callback');
assert.equal(inactiveBack.calls.length, 0, 'inactive page does not dispatch Web back');
assert.equal(inactiveBack.backgroundCalls.length, 0, 'inactive page does not request ability backgrounding');

const rejectedBackground = readyBackHost(Promise.resolve('false'), {
  moveAbilityToBackground: async () => { throw new Error('background transition denied'); },
});
rejectedBackground.page.onBackPress();
await drain();
assert.equal(rejectedBackground.page.backNavigationError,
  '系统返回未完成：background transition denied。当前页面仍保留，可重试返回或继续使用。',
  'a rejected ability transition leaves a concrete retry/error state on the Index instance');
assert.match(rejectedBackground.page.startupMessage, /无法安全返回桌面：background transition denied/);
assert.ok(rejectedBackground.errors.some(message => message.includes('background transition denied')));
assert.match(pageSource, /backNavigationError[\s\S]*\.onClick\(\(\) => this\.onBackPress\(\)\)/,
  'the rendered page exposes its background failure state and a retry action');

const failedBackgroundTransition = deferred();
let retryBackgroundCalls = 0;
const retryAfterBackgroundFailure = readyBackHost(Promise.resolve('false'), {
  moveAbilityToBackground: () => {
    retryBackgroundCalls += 1;
    return retryBackgroundCalls === 1 ? failedBackgroundTransition.promise : Promise.resolve();
  },
});
retryAfterBackgroundFailure.page.onBackPress();
await drain();
assert.equal(retryBackgroundCalls, 1, 'initial Web-unhandled back starts one deferred transition');
failedBackgroundTransition.reject(new Error('temporary rejection'));
await drain();
assert.match(retryAfterBackgroundFailure.page.backNavigationError, /temporary rejection/);
retryAfterBackgroundFailure.page.onBackPress();
await drain();
assert.equal(retryBackgroundCalls, 2, 'settled transition failure clears pending state and permits a real retry');
assert.equal(retryAfterBackgroundFailure.page.backNavigationError, '', 'successful retry clears the visible background error');

console.log('verify-harmony-host-lifecycle: PASS (transpiled Index.onBackPress to WebControllerRegistry and API-shaped WebView/ability mocks; not ArkUI SDK compilation or OS/device validation)');
