import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';
import { patchCapacitorCore, capacitorListenerPatch } from '../tools/patch-capacitor-core.mjs';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(mobileRoot, 'dist');

class MockElement {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.attributes = {}; this.listeners = new Map(); this.style = {}; this.disabled = false; this._text = ''; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; this._text = ''; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); return child; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  click() { this.listeners.get('click')?.({ target: this }); }
}

async function runActualMain({ mobile, vue, scriptLoadsVue = false, language = 'en' } = {}) {
  const mainPath = path.resolve(mobileRoot, '../web/web前端/main.js');
  const source = await readFile(mainPath, 'utf8');
  const app = { innerHTML: '' };
  const scriptRequests = [];
  let mounted = false;
  const sandbox = {
    console: { error() {}, warn() {} }, URL, URLSearchParams,
    __LIFELINE_MOBILE_APP__: mobile,
    localStorage: { getItem: () => language }, navigator: { language },
    document: {
      querySelector: () => app,
      createElement: () => ({ set src(value) { this._src = value; }, get src() { return this._src; } }),
      head: { appendChild(script) {
        scriptRequests.push(script.src);
        if (scriptLoadsVue) sandbox.Vue = { createApp() { return { mount() { mounted = true; } }; } };
        queueMicrotask(() => script.onload?.());
      } },
    },
    Vue: typeof vue?.createApp === 'function'
      ? { ...vue, createApp(...args) {
        const instance = vue.createApp(...args);
        return { ...instance, mount(...mountArgs) { mounted = true; return instance.mount(...mountArgs); } };
      } }
      : vue,
  };
  const context = vm.createContext(sandbox);
  const appModule = new vm.SyntheticModule(['default'], function () { this.setExport('default', {}); }, { context });
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: pathToFileURL(mainPath).href,
    initializeImportMeta(meta) { meta.url = pathToFileURL(mainPath).href; },
    importModuleDynamically: async () => {
      if (appModule.status === 'unlinked') await appModule.link(() => { throw new Error('unexpected static import'); });
      if (appModule.status === 'linked') await appModule.evaluate();
      return appModule;
    },
  });
  await module.link(() => { throw new Error('unexpected static import'); });
  await module.evaluate();
  // The current Web bootstrap loads two topology modules before OnlineApp.
  // Give those real asynchronous imports time to settle in the VM harness.
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
  return { app, scriptRequests, get mounted() { return mounted; } };
}

for (const vue of [undefined, {}, { createApp: true }]) {
  const result = await runActualMain({ mobile: true, vue });
  assert.equal(result.scriptRequests.length, 0, 'mobile startup never requests a Vue CDN');
  assert.match(result.app.innerHTML, /App Failed To Start/);
  assert.match(result.app.innerHTML, /local resources required to start the app could not be loaded/i);
  assert.doesNotMatch(result.app.innerHTML, /Mobile app runtime is unavailable|Vue runtime/i,
    'mobile startup omits technical runtime diagnostics from player-facing text');
}
const chineseMobileFailure = await runActualMain({ mobile: true, vue: {}, language: 'zh' });
assert.match(chineseMobileFailure.app.innerHTML, /应用启动失败/);
assert.match(chineseMobileFailure.app.innerHTML, /应用启动所需的本地资源未能加载/);
assert.doesNotMatch(chineseMobileFailure.app.innerHTML, /Mobile app runtime is unavailable|Vue runtime/);
for (const vue of [undefined, {}]) {
  const result = await runActualMain({ mobile: false, vue, scriptLoadsVue: true });
  assert.equal(result.scriptRequests.length, 1, 'ordinary web startup retains its CDN fallback');
  assert.equal(result.mounted, true, 'ordinary web startup mounts after the CDN supplies Vue');
}
const localVueStartup = await runActualMain({ mobile: true, vue: { createApp() { return { mount() { } }; } } });
assert.equal(localVueStartup.scriptRequests.length, 0);
assert.equal(localVueStartup.mounted, true);
assert.equal(localVueStartup.app.innerHTML, '');

async function executeEntry({
  harmony,
  capacitorNative = false,
  initialLocal = [],
  initialNative = [],
  failLocalGet = false,
  failNativeLoad = false,
  failNextNativeSave = false,
  failAppListener = false,
  initialAppActive = true,
  dispatchBackgroundDuringLoad = false,
  dispatchUnrelatedRejectionDuringLoad = false,
  failMainImport = false,
  failPlatformModuleImport = false,
  initialReplayFiles = [],
  shareOutcome = 'selected',
  failReplayWrite = false,
  delayReplayWrite = false,
}) {
  const calls = [];
  let appStateListener = null;
  const localValues = new Map(initialLocal);
  const localWrites = [];
  const eventTarget = new EventTarget();
  const nativeValues = new Map(initialNative);
  let credentialOwnerGeneration = 0;
  let nativeCredentialState = 'missing';
  let nativeCredential = null;
  const nativeDocumentNonce = 'synthetic-native-credential-document-nonce';
  function handleCredentialOperation(operation, request) {
    if (operation === 'claimCredentialOwner') {
      assert.match(request.documentChallenge, /^[a-f0-9]{64}$/, 'claim carries a freshly generated 256-bit document challenge');
      assert.equal(request.documentChallenge, sandbox.__LIFELINE_DOCUMENT_CHALLENGE__, 'native claim verifies the exact generated document challenge');
      assert.equal(typeof request.expectedOwnerGeneration, 'number');
      if (request.expectedOwnerGeneration !== -1) assert.equal(request.expectedOwnerGeneration, credentialOwnerGeneration);
      credentialOwnerGeneration += 1;
      return { pageEpoch: 17, ownerGeneration: credentialOwnerGeneration, documentNonce: nativeDocumentNonce };
    }
    assert.equal(request.pageEpoch, 17, `${operation} carries the native-issued page epoch`);
    assert.equal(request.ownerGeneration, credentialOwnerGeneration, `${operation} carries the current native owner generation`);
    assert.equal(request.documentNonce, nativeDocumentNonce, `${operation} carries the native-issued document nonce`);
    if (operation === 'loadCredential') return nativeCredentialState === 'present'
      ? { state: 'present', credential: structuredClone(nativeCredential) } : { state: nativeCredentialState };
    if (operation === 'saveCredential') {
      assert.deepEqual(Object.keys(request.credential).sort(), ['token', 'username']);
      nativeCredential = structuredClone(request.credential);
      nativeCredentialState = 'present';
      return { durable: true };
    }
    if (operation === 'clearCredential') {
      nativeCredential = null;
      nativeCredentialState = 'cleared';
      return { durable: true };
    }
    throw new Error(`unexpected credential operation: ${operation}`);
  }
  const replayFiles = new Map(initialReplayFiles);
  const replayApiCalls = [];
  let replayCacheReady = initialReplayFiles.length > 0;
  let currentShareOutcome = shareOutcome;
  let pendingShare = null;
  let finishReplayWrite = null;
  let nextShareTimer = 0;
  const shareTimers = new Map();
  let delayNextNativeSave = false;
  let releaseDelayedNativeSave = null;
  let reloadCount = 0;
  const body = new MockElement('body');
  body.append(new MockElement('div'));
  const document = {
    hidden: false,
    visibilityState: 'visible',
    body,
    createElement: (tagName) => new MockElement(tagName),
    addEventListener() {},
    removeEventListener() {},
  };
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Uint32Array,
    ArrayBuffer,
    Blob,
    Response,
    Request,
    Headers,
    CustomEvent,
    Event,
    EventTarget,
    crypto: webcrypto,
    setTimeout(callback, delay, ...args) {
      if (delay === 30_000 || delay === 540_000) {
        const id = `share-timeout-${++nextShareTimer}`;
        shareTimers.set(id, { callback, delay });
        return id;
      }
      return setTimeout(callback, delay, ...args);
    },
    clearTimeout(id) {
      if (typeof id === 'string' && id.startsWith('share-timeout-')) shareTimers.delete(id);
      else clearTimeout(id);
    },
    queueMicrotask,
    localStorage: {
      getItem: (key) => {
        if (failLocalGet) throw new Error('synthetic localStorage getItem failure');
        return localValues.get(key) ?? null;
      },
      setItem: (key, value) => { localWrites.push([key, String(value)]); localValues.set(key, String(value)); },
      removeItem: (key) => localValues.delete(key),
    },
    registeredGlobalListeners: [],
    addEventListener(type, callback) {
      sandbox.registeredGlobalListeners.push(type);
      eventTarget.addEventListener(type, callback);
    },
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    document,
    location: { reload() { reloadCount += 1; } },
    __mobileMainStarted: false,
  };
  if (harmony) {
    sandbox.LifelineArkTS = {
      callNative(requestId, operation, key, value) {
        calls.push({ operation, key, value });
        if (operation === 'loadRecord' && failNativeLoad) {
          queueMicrotask(() => sandbox.__lifelineNativeComplete?.(requestId, JSON.stringify({ ok: false, error: 'synthetic native load failure' })));
          return;
        }
        if (operation === 'saveRecord' && failNextNativeSave) {
          failNextNativeSave = false;
          queueMicrotask(() => sandbox.__lifelineNativeComplete?.(requestId, JSON.stringify({ ok: false, error: 'mock durable write failure' })));
          return;
        }
        let result;
        if (['claimCredentialOwner', 'loadCredential', 'saveCredential', 'clearCredential'].includes(operation)) {
          result = handleCredentialOperation(operation, value ? JSON.parse(value) : {});
        } else if (operation === 'loadRecord') result = { value: nativeValues.get(key) ?? null };
        else if (operation === 'saveRecord') {
          nativeValues.set(key, value);
          result = { flushed: true };
        } else if (operation === 'removeRecord') {
          nativeValues.delete(key);
          result = { flushed: true };
        } else throw new Error(`unexpected native operation: ${operation}`);
        queueMicrotask(() => sandbox.__lifelineNativeComplete?.(requestId, JSON.stringify({ ok: true, result })));
      },
    };
  } else if (capacitorNative) {
    sandbox.CapacitorCustomPlatform = { name: 'android' };
    sandbox.Capacitor = {
      Plugins: {},
      PluginHeaders: [
        { name: 'LifelineStorage', methods: [
          { name: 'loadRecord', rtype: 'promise' },
          { name: 'saveRecord', rtype: 'promise' },
          { name: 'removeRecord', rtype: 'promise' },
          { name: 'claimCredentialOwner', rtype: 'promise' },
          { name: 'loadCredential', rtype: 'promise' },
          { name: 'saveCredential', rtype: 'promise' },
          { name: 'clearCredential', rtype: 'promise' },
        ] },
        { name: 'App', methods: [
          { name: 'addListener', rtype: 'callback' },
          { name: 'removeListener', rtype: 'promise' },
          { name: 'getState', rtype: 'promise' },
        ] },
        { name: 'Filesystem', methods: [
          { name: 'writeFile', rtype: 'promise' }, { name: 'getUri', rtype: 'promise' },
          { name: 'readdir', rtype: 'promise' }, { name: 'mkdir', rtype: 'promise' },
          { name: 'deleteFile', rtype: 'promise' },
        ] },
        { name: 'Share', methods: [{ name: 'share', rtype: 'promise' }] },
      ],
      nativePromise(plugin, method, args) {
        if (plugin === 'App' && method === 'getState') {
          calls.push({ operation: method, plugin });
          return Promise.resolve({ isActive: initialAppActive });
        }
        if (plugin === 'Filesystem') {
          replayApiCalls.push({ plugin, method, args: { ...args } });
          const cachePath = 'lifeline-replay-share';
          if (method === 'mkdir') { replayCacheReady = true; return Promise.resolve(); }
          if (method === 'readdir') {
            if (!replayCacheReady) return Promise.reject(new Error('Folder does not exist.'));
            return Promise.resolve({ files: [...replayFiles.entries()].map(([name, info]) => ({
              name, type: 'file', size: info.size, ctime: info.createdAt, mtime: info.createdAt,
            })) });
          }
          if (method === 'writeFile') {
            if (args.directory !== 'CACHE' || !args.path.startsWith(`${cachePath}/`)) return Promise.reject(new Error('Wrong cache path'));
            const name = args.path.slice(cachePath.length + 1);
            replayFiles.set(name, { data: args.data, size: new TextEncoder().encode(args.data).length, createdAt: Date.now() });
            if (failReplayWrite) return Promise.reject(new Error('synthetic replay write failure after partial file creation'));
            replayCacheReady = true;
            if (delayReplayWrite) return new Promise((resolve) => { finishReplayWrite = () => resolve({ uri: `file:///cache/${args.path}` }); });
            return Promise.resolve({ uri: `file:///cache/${args.path}` });
          }
          if (method === 'getUri') return Promise.resolve({ uri: `file:///cache/${args.path}` });
          if (method === 'deleteFile') { replayFiles.delete(args.path.slice(cachePath.length + 1)); return Promise.resolve(); }
          return Promise.reject(new Error(`Unexpected Filesystem method: ${method}`));
        }
        if (plugin === 'Share' && method === 'share') {
          replayApiCalls.push({ plugin, method, args: { ...args } });
          if (currentShareOutcome === 'pending') return new Promise((resolve, reject) => { pendingShare = { resolve, reject }; });
          if (currentShareOutcome === 'cancel') return Promise.reject(new Error('Share canceled'));
          if (currentShareOutcome === 'failure') return Promise.reject(new Error('synthetic chooser failure'));
          return Promise.resolve({ activityType: currentShareOutcome === 'returned' ? '' : 'com.example.receiver' });
        }
        calls.push({ operation: method, key: args.key, value: args.value, plugin,
          ...(method === 'claimCredentialOwner' ? { request: args } : {}) });
        if (plugin === 'LifelineStorage' && ['claimCredentialOwner', 'loadCredential', 'saveCredential', 'clearCredential'].includes(method)) {
          return Promise.resolve(handleCredentialOperation(method, args));
        }
        if (plugin === 'LifelineStorage' && method === 'loadRecord' && failNativeLoad) return Promise.reject(new Error('synthetic native load failure'));
        if (plugin === 'LifelineStorage' && method === 'loadRecord' && dispatchBackgroundDuringLoad) {
          return new Promise((resolve) => setTimeout(() => {
            appStateListener?.({ isActive: false });
            resolve({ value: nativeValues.get(args.key) ?? null });
          }, 10));
        }
        if (plugin === 'LifelineStorage' && method === 'loadRecord' && dispatchUnrelatedRejectionDuringLoad) {
          const unrelated = new Event('unhandledrejection', { cancelable: true });
          Object.defineProperty(unrelated, 'reason', { value: new Error('unrelated asynchronous rejection') });
          eventTarget.dispatchEvent(unrelated);
          sandbox.__unrelatedRejectionPrevented = unrelated.defaultPrevented;
          return new Promise((resolve) => setTimeout(() => resolve({ value: nativeValues.get(args.key) ?? null }), 10));
        }
        if (plugin === 'LifelineStorage' && method === 'saveRecord' && failNextNativeSave) {
          failNextNativeSave = false;
          return Promise.reject(new Error('synthetic durable write failure'));
        }
        if (plugin === 'LifelineStorage' && method === 'loadRecord') return Promise.resolve({ value: nativeValues.get(args.key) ?? null });
        if (plugin === 'LifelineStorage' && method === 'saveRecord') {
          nativeValues.set(args.key, args.value);
          return Promise.resolve({ durable: true });
        }
        if (plugin === 'LifelineStorage' && method === 'removeRecord') {
          nativeValues.delete(args.key);
          return Promise.resolve({ durable: true });
        }
        throw new Error(`unexpected Capacitor native request: ${plugin}.${method}`);
      },
      nativeCallback(plugin, method, _args, callback) {
        calls.push({ operation: method, plugin });
        if (plugin === 'App' && method === 'addListener' && failAppListener === 'throw') {
          throw new Error('synthetic nativeCallback synchronous throw');
        }
        if (plugin === 'App' && method === 'addListener' && failAppListener === 'reject') {
          return Promise.reject(new Error('synthetic nativeCallback rejected promise'));
        }
        if (plugin === 'App' && method === 'addListener') appStateListener = callback;
        return Promise.resolve('mock-app-state-listener');
      },
    };
  }

  const context = vm.createContext(sandbox);
  const modules = new Map();
  const mainModuleUrl = pathToFileURL(path.join(dist, 'main.js')).href;
  async function getModule(url) {
    if (url.split('?')[0] === mainModuleUrl) {
      if (!modules.has(mainModuleUrl)) {
        const mainSource = failMainImport
          ? 'throw new Error("synthetic application module failure");'
          : 'globalThis.__mobileMainStarted = true; export const mockedMain = true;';
        modules.set(mainModuleUrl, new vm.SourceTextModule(mainSource, {
          context,
          identifier: mainModuleUrl,
          importModuleDynamically,
        }));
      }
      return modules.get(mainModuleUrl);
    }
    const key = url.split('?')[0];
    if (failPlatformModuleImport && key.endsWith('/platform/harmony-bridge.js')) throw new Error('synthetic platform import failure');
    if (!modules.has(key)) {
      const source = await readFile(fileURLToPath(key), 'utf8');
      modules.set(key, new vm.SourceTextModule(source, { context, identifier: key, importModuleDynamically }));
    }
    return modules.get(key);
  }
  async function linkModule(specifier, referencingModule) {
    const resolved = new URL(specifier, referencingModule.identifier).href;
    return getModule(resolved);
  }
  async function importModuleDynamically(specifier, referencingModule) {
    const child = await linkModule(specifier, referencingModule);
    if (child.status === 'unlinked') await child.link(linkModule);
    if (child.status === 'linked') await child.evaluate();
    return child;
  }

  const entryUrl = pathToFileURL(path.join(dist, 'mobile-entry.js')).href;
  const entry = await getModule(entryUrl);
  await entry.link(linkModule);
  await entry.evaluate();
  return {
    sandbox, calls, localValues, localWrites, nativeValues, body,
    emitAppState(isActive) { appStateListener?.({ isActive }); },
    get reloadCount() { return reloadCount; },
    replayFiles,
    replayApiCalls,
    setShareOutcome(value) { currentShareOutcome = value; },
    resolvePendingShare(activityType = 'com.example.receiver') { const pending = pendingShare; pendingShare = null; pending?.resolve({ activityType }); },
    rejectPendingShare(error = new Error('Share canceled')) { const pending = pendingShare; pendingShare = null; pending?.reject(error); },
    fireShareTimeout(delay = 540_000) { const entry = [...shareTimers.entries()].find(([, timer]) => timer.delay === delay); const [id, timer] = entry ?? []; if (timer) { shareTimers.delete(id); timer.callback(); } },
    releaseReplayWrite() { const finish = finishReplayWrite; finishReplayWrite = null; finish?.(); },
    loadPlatform: async () => (await importModuleDynamically('./platform/mobile-bridge.js', entry)).namespace,
    loadReplayCodec: async () => (await importModuleDynamically('./ReplayCodec.js', entry)).namespace,
    failNativeSave() { failNextNativeSave = true; },
    delayNativeSave() { delayNextNativeSave = true; },
    releaseDelayedNativeSave() { const release = releaseDelayedNativeSave; releaseDelayedNativeSave = null; release?.(); },
    loadLocalSession: async () => (await importModuleDynamically("./LocalGameSession.js?v=20261013-full-features1", entry)).namespace,
  };
}

const sessionKey = 'lifeline-local-game-session-v1';
const harmony = await executeEntry({ harmony: true });
assert.equal(harmony.sandbox.LifelinePlatform.isNative, true);
assert.deepEqual(harmony.calls.map(({ operation }) => operation), ['loadRecord', 'loadRecord', 'claimCredentialOwner', 'loadCredential'],
  'Harmony initialization loads both native sessions, claims the document owner, then reads native credential state');
const harmonyClaim = harmony.calls.find(({ operation }) => operation === 'claimCredentialOwner');
const harmonyClaimRequest = JSON.parse(harmonyClaim.value);
assert.match(harmony.sandbox.__LIFELINE_DOCUMENT_CHALLENGE__, /^[a-f0-9]{64}$/, 'entry generates a 256-bit challenge from the runtime crypto source');
assert.equal(harmonyClaimRequest.documentChallenge, harmony.sandbox.__LIFELINE_DOCUMENT_CHALLENGE__, 'native ownership claim is bound to that generated challenge');
assert.equal(harmonyClaimRequest.expectedOwnerGeneration, -1, 'startup acquires a fresh native owner lease');
const harmonySession = await harmony.loadLocalSession();
const settings = { playerCount: 2, gridSize: 5, startPlayer: 'BLACK', rulesVersion: 'territory-v2' };
const game = harmonySession.createLocalGameSession(settings);
assert.equal(harmonySession.persistLocalGameSession(game), true, 'real LocalGameSession writer persists a save');
await harmony.sandbox.LifelinePlatform.flushSessionMirror();
const savedEnvelope = JSON.parse(harmony.localValues.get(sessionKey));
assert.equal(savedEnvelope.format, 'lifeline-local-session-envelope');
assert.equal(savedEnvelope.revision, 1);
assert.equal(savedEnvelope.state, 'saved');
assert.equal(harmony.nativeValues.get(sessionKey), harmony.localValues.get(sessionKey), 'Harmony mirror stores the exact saved envelope');
assert.equal(harmonySession.loadLocalGameSession().settings.gridSize, 5, 'application loader unwraps the envelope');

const nativeCallsBeforeQuota = harmony.calls.filter(({ operation }) => operation === 'saveRecord').length;
const originalSetItem = harmony.sandbox.localStorage.setItem;
harmony.sandbox.localStorage.setItem = () => { throw new Error('mock quota failure'); };
assert.equal(harmonySession.persistLocalGameSession(game), false, 'local write failure rejects the app save');
assert.equal(harmony.calls.filter(({ operation }) => operation === 'saveRecord').length, nativeCallsBeforeQuota, 'local write failure does not enqueue native work');
harmony.sandbox.localStorage.setItem = originalSetItem;

assert.equal(harmonySession.clearLocalGameSession(), true, 'real LocalGameSession clear writes a tombstone envelope');
await harmony.sandbox.LifelinePlatform.flushSessionMirror();
const clearedEnvelope = JSON.parse(harmony.localValues.get(sessionKey));
assert.equal(clearedEnvelope.state, 'cleared');
assert.equal(clearedEnvelope.revision, 2);
assert.equal(harmony.nativeValues.get(sessionKey), harmony.localValues.get(sessionKey));
assert.equal(harmonySession.loadLocalGameSession(), null, 'cleared envelope loads as no active match');

harmony.failNativeSave();
assert.equal(harmonySession.persistLocalGameSession(game), true, 'local save survives a native failure');
await assert.rejects(harmony.sandbox.LifelinePlatform.flushSessionMirror(), /mock durable write failure/);
const retainedAfterNativeFailure = JSON.parse(harmony.localValues.get(sessionKey));
assert.equal(retainedAfterNativeFailure.revision, 3);
assert.equal(harmony.sandbox.__LIFELINE_STORAGE_STATUS__.state, 'error');
assert.equal(harmonySession.persistLocalGameSession(game), true, 'later save can recover a failed native mirror');
await harmony.sandbox.LifelinePlatform.flushSessionMirror();
assert.equal(harmony.nativeValues.get(sessionKey), harmony.localValues.get(sessionKey), 'later revision repairs the native mirror');
assert.equal(harmony.sandbox.__LIFELINE_STORAGE_STATUS__.state, 'confirmed', 'only the current successful revision confirms storage');

const localEnvelopeForConflict = JSON.parse(harmony.localValues.get(sessionKey));
const conflictedNative = JSON.stringify({ ...localEnvelopeForConflict, payload: JSON.stringify({ ...game, savedAt: game.savedAt + 1 }) });
const conflictStartup = await executeEntry({ harmony: true, initialLocal: [[sessionKey, harmony.localValues.get(sessionKey)]], initialNative: [[sessionKey, conflictedNative]] });
assert.equal(conflictStartup.sandbox.__LIFELINE_STORAGE_STATUS__.state, 'conflict', 'same-revision divergence is visible at native startup');
const conflictSession = await conflictStartup.loadLocalSession();
assert.equal(conflictSession.persistLocalGameSession(game), false, 'conflict blocks automatic session persistence');
assert.equal(conflictStartup.localValues.get(sessionKey), harmony.localValues.get(sessionKey), 'conflict preserves the local evidence');
assert.equal(conflictStartup.nativeValues.get(sessionKey), conflictedNative, 'conflict preserves the native evidence');
assert.equal(conflictSession.clearLocalGameSession(), true, 'explicit clear resolves a conflict');
await conflictStartup.sandbox.LifelinePlatform.flushSessionMirror();
assert.equal(JSON.parse(conflictStartup.nativeValues.get(sessionKey)).state, 'cleared');

for (const legacyTombstone of ['__lifeline_native_session_cleared_v1__', '__LIFELINE_CLEARED_V1__']) {
  const legacyClearStartup = await executeEntry({ harmony: true, initialNative: [[sessionKey, legacyTombstone]] });
  await legacyClearStartup.sandbox.LifelinePlatform.flushSessionMirror();
  assert.equal(JSON.parse(legacyClearStartup.localValues.get(sessionKey)).state, 'cleared', 'legacy native clear migrates into a versioned envelope');
  assert.equal(legacyClearStartup.sandbox.__LIFELINE_STORAGE_STATUS__.state, 'cleared');
}
for (const platform of [{ harmony: true, capacitorNative: false }, { harmony: false, capacitorNative: true }]) {
  const delayedReceiptEntry = await executeEntry(platform);
  const sessionApi = await delayedReceiptEntry.loadLocalSession();
  delayedReceiptEntry.delayNativeSave();
  assert.equal(sessionApi.persistLocalGameSession(game), true, 'save A enters the local store and delayed native queue');
  const delayedFlush = delayedReceiptEntry.sandbox.LifelinePlatform.flushSessionMirror();
  const setItem = delayedReceiptEntry.sandbox.localStorage.setItem;
  delayedReceiptEntry.sandbox.localStorage.setItem = () => { throw new Error('mock quota failure for save B'); };
  assert.equal(sessionApi.persistLocalGameSession({ ...game, savedAt: game.savedAt + 10 }), false, 'save B fails before native enqueue');
  assert.equal(delayedReceiptEntry.sandbox.__LIFELINE_STORAGE_STATUS__.state, 'error');
  delayedReceiptEntry.sandbox.localStorage.setItem = setItem;
  delayedReceiptEntry.releaseDelayedNativeSave();
  await delayedFlush;
  assert.equal(delayedReceiptEntry.sandbox.__LIFELINE_STORAGE_STATUS__.state, 'error', 'late confirmation for A cannot override B local-write failure');
}
const capacitor = await executeEntry({ harmony: false });
assert.equal(capacitor.sandbox.LifelinePlatform.isNative, false, 'without the ArkWeb proxy, entry initializes the Capacitor web fallback');
assert.equal(capacitor.sandbox.__mobileMainStarted, true, 'Capacitor branch also reaches the main bootstrap');
const capacitorSession = await capacitor.loadLocalSession();
assert.equal(capacitorSession.persistLocalGameSession(capacitorSession.createLocalGameSession(settings)), true, 'Capacitor web fallback writes a local envelope');
assert.equal(JSON.parse(capacitor.localValues.get(sessionKey)).revision, 1);
assert.deepEqual({state:capacitor.sandbox.__LIFELINE_STORAGE_STATUS__.state,nativeAvailable:capacitor.sandbox.__LIFELINE_STORAGE_STATUS__.nativeAvailable,source:capacitor.sandbox.__LIFELINE_STORAGE_STATUS__.source,operation:capacitor.sandbox.__LIFELINE_STORAGE_STATUS__.operation},
  {state:'confirmed',nativeAvailable:false,source:'local',operation:'saved'},'web fallback reports only the local save it wrote');

const android = await executeEntry({ harmony: false, capacitorNative: true });
assert.equal(android.sandbox.LifelinePlatform.isNative, true, 'Capacitor Android initializes its native storage bridge');
assert.ok(android.calls.some(({ operation }) => operation === 'loadRecord'), 'Capacitor startup loads native session data');
assert.deepEqual(android.calls.filter(({ operation }) => ['claimCredentialOwner', 'loadCredential'].includes(operation)).map(({ operation }) => operation),
  ['claimCredentialOwner', 'loadCredential'], 'Android startup claims native credential ownership before loading its credential');
const androidClaim = android.calls.find(({ operation }) => operation === 'claimCredentialOwner');
const androidClaimRequest = androidClaim.request;
assert.match(android.sandbox.__LIFELINE_DOCUMENT_CHALLENGE__, /^[a-f0-9]{64}$/);
assert.equal(androidClaimRequest.documentChallenge, android.sandbox.__LIFELINE_DOCUMENT_CHALLENGE__, 'Android claim is bound to the generated document challenge');
assert.equal(androidClaimRequest.expectedOwnerGeneration, -1);
const androidSession = await android.loadLocalSession();
assert.equal(androidSession.persistLocalGameSession(androidSession.createLocalGameSession(settings)), true);
await android.sandbox.LifelinePlatform.flushSessionMirror();
assert.equal(android.nativeValues.get(sessionKey), android.localValues.get(sessionKey), 'Capacitor session save reaches the mocked native plugin');
assert.ok(android.calls.some(({ operation }) => operation === 'saveRecord'), 'Capacitor flush completes the native save');
function assertStartupFailureUi(result, expectedLocal, expectedNative) {
  assert.equal(result.sandbox.__mobileMainStarted, false, 'the main application bootstrap does not run after startup failure');
  assert.equal(result.body.children.length, 1, 'the startup failure replaces the blank game shell with a visible panel');
  const panel = result.body.children[0];
  assert.equal(panel.attributes.role, 'alert');
  assert.equal(panel.attributes['aria-live'], 'assertive');
  assert.match(panel.textContent, /启动未完成/);
  assert.match(panel.textContent, /保存状态待确认/);
  assert.match(panel.textContent, /不会自动清除或重置/);
  assert.doesNotMatch(panel.textContent, /synthetic|stack|Error:/i, 'internal errors are not shown as product copy');
  const retry = panel.children.find((element) => element.tagName === 'button');
  assert.ok(retry, 'a visible retry button is rendered');
  assert.equal(retry.textContent, '重试启动');
  const nativeCallCount = result.calls.length;
  retry.click();
  assert.equal(result.reloadCount, 1, 'retry explicitly requests a page reload');
  assert.equal(retry.textContent, '正在重新启动…');
  retry.click();
  assert.equal(result.reloadCount, 1, 'repeated taps do not queue duplicate restart requests');
  assert.equal(result.calls.length, nativeCallCount, 'retry handler does not start duplicate platform listeners or storage writers in-page');
  assert.deepEqual([...result.localValues.entries()], expectedLocal, 'failure leaves every mock local-storage byte unchanged');
  assert.deepEqual([...result.nativeValues.entries()], expectedNative, 'failure leaves every mock native-storage byte unchanged');
  assert.deepEqual(result.localWrites, [], 'startup failure never automatically writes or resets local storage');
}

const localStoredBytes = JSON.stringify(savedEnvelope);
for (const platform of [
  { name: 'Android', harmony: false, capacitorNative: true },
  { name: 'Harmony', harmony: true, capacitorNative: false },
]) {
  const lifecyclePrefix = platform.capacitorNative ? ['addListener', 'addListener', 'getState'] : [];
  const localReadFailureLocal = [[sessionKey, localStoredBytes]];
  const localReadFailureNative = [[sessionKey, localStoredBytes]];
  const localReadFailure = await executeEntry({ ...platform, initialLocal: localReadFailureLocal, initialNative: localReadFailureNative, failLocalGet: true });
  assertStartupFailureUi(localReadFailure, localReadFailureLocal, localReadFailureNative);
  assert.deepEqual(localReadFailure.calls.map(({ operation }) => operation), lifecyclePrefix, `${platform.name} local read error prevents native storage reads and writes`);

  const nativeReadFailureLocal = [[sessionKey, localStoredBytes]];
  const nativeReadFailureNative = [[sessionKey, localStoredBytes]];
  const nativeReadFailure = await executeEntry({ ...platform, initialLocal: nativeReadFailureLocal, initialNative: nativeReadFailureNative, failNativeLoad: true });
  assertStartupFailureUi(nativeReadFailure, nativeReadFailureLocal, nativeReadFailureNative);
  assert.deepEqual(nativeReadFailure.calls.map(({ operation }) => operation), [...lifecyclePrefix, 'loadRecord'], `${platform.name} load failure does not begin automatic writes`);

  const recoveryLocal = JSON.stringify({ ...savedEnvelope, revision: 5 });
  const recoveryNative = JSON.stringify({ ...savedEnvelope, revision: 4 });
  const recoveryFailureLocal = [[sessionKey, recoveryLocal]];
  const recoveryFailureNative = [[sessionKey, recoveryNative]];
  const recoveryFailure = await executeEntry({
    ...platform,
    initialLocal: recoveryFailureLocal,
    initialNative: recoveryFailureNative,
    failNextNativeSave: true,
  });
  assertStartupFailureUi(recoveryFailure, recoveryFailureLocal, recoveryFailureNative);
  assert.deepEqual(recoveryFailure.calls.map(({ operation }) => operation), [...lifecyclePrefix, 'loadRecord', 'saveRecord'], `${platform.name} recovery sync fails once without overwriting its source record`);
}

const patchPackage = JSON.parse(await readFile(path.join(mobileRoot, 'node_modules/@capacitor/core/package.json'), 'utf8'));
assert.equal(patchPackage.version, capacitorListenerPatch.version, 'tested Capacitor package matches the patched version');
const capacitorCorePath = path.join(mobileRoot, 'node_modules/@capacitor/core/dist/index.js');
const capacitorCoreSource = await readFile(capacitorCorePath, 'utf8');
const transformedCore = await patchCapacitorCore(capacitorCoreSource, capacitorCorePath);
assert.ok(transformedCore.includes(capacitorListenerPatch.patched), 'build-time patch propagates addListener rejection');
await assert.rejects(patchCapacitorCore(capacitorCoreSource.replace(capacitorListenerPatch.original, 'changed'), capacitorCorePath), /source hash mismatch/, 'upstream source drift fails closed');

async function runStandaloneBackBootstrap(href, canGoBack) {
  let listener = null;
  let backgroundCalls = 0;
  let historyBackCalls = 0;
  const nativeCalls = [];
  const eventTarget = new EventTarget();
  const context = vm.createContext({
    console, URL, CustomEvent, Event, EventTarget,
    location: new URL(href),
    history: { back() { historyBackCalls += 1; } },
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
  });
  const app = {
    addListener(name, callback) { nativeCalls.push(name); listener = callback; return Promise.resolve({ remove() {} }); },
    minimizeApp() { backgroundCalls += 1; return Promise.resolve(); },
  };
  const source = await readFile(path.join(mobileRoot, 'src/native-back-bootstrap.js'), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: 'file:///standalone/native-back-bootstrap.js' });
  await module.link((specifier) => {
    if (specifier === '@capacitor/app') return new vm.SyntheticModule(['App'], function() { this.setExport('App', app); }, { context });
    if (specifier === '@capacitor/core') return new vm.SyntheticModule(['Capacitor'], function() {
      this.setExport('Capacitor', { isNativePlatform: () => true });
    }, { context });
    throw new Error(`Unexpected standalone back import: ${specifier}`);
  });
  await module.evaluate();
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  assert.deepEqual(nativeCalls, ['backButton']);
  assert.equal(typeof listener, 'function', 'standalone legal/startup handler installs its native listener');
  listener({ canGoBack });
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  return { historyBackCalls, backgroundCalls };
}
assert.deepEqual(await runStandaloneBackBootstrap('https://localhost/legal/THIRD_PARTY_NOTICES.html', true),
  { historyBackCalls: 1, backgroundCalls: 0 }, 'standalone notices return through native WebView history only on their exact bundled route');
assert.deepEqual(await runStandaloneBackBootstrap('https://localhost/index.html', true),
  { historyBackCalls: 0, backgroundCalls: 1 }, 'startup UI with no root listener backgrounds instead of silently trapping on an empty history');

for (const failure of ['throw', 'reject']) {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  let appListenerFailure;
  try {
    appListenerFailure = await executeEntry({ harmony: false, capacitorNative: true, failAppListener: failure });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assertStartupFailureUi(appListenerFailure, [], []);
  assert.deepEqual(appListenerFailure.calls.map(({ operation }) => operation), ['addListener', 'addListener']);
  assert.deepEqual(unhandled, [], `nativeCallback ${failure} is propagated through the awaited listener promise without an unhandled rejection`);
}

const unrelatedStartupRejection = await executeEntry({ harmony: false, capacitorNative: true, dispatchUnrelatedRejectionDuringLoad: true });
assert.equal(unrelatedStartupRejection.sandbox.__mobileMainStarted, true, 'an unrelated rejection event does not cancel a successful asynchronous startup');
assert.equal(unrelatedStartupRejection.body.children.length, 1, 'successful async startup keeps the normal shell instead of showing a false failure');
assert.equal(unrelatedStartupRejection.sandbox.__unrelatedRejectionPrevented, false, 'the entry does not suppress unrelated unhandled rejection events');
assert.ok(!unrelatedStartupRejection.sandbox.registeredGlobalListeners.includes('unhandledrejection'), 'the entry installs no global unhandled rejection handler');

const initiallyBackgroundedAndroid = await executeEntry({ harmony: false, capacitorNative: true, initialAppActive: false });
assert.deepEqual(initiallyBackgroundedAndroid.calls.slice(0, 4).map(({ operation }) => operation), ['addListener', 'addListener', 'getState', 'loadRecord'],
  'Android subscribes before reading initial app state and before session storage can delay startup');
assert.equal(initiallyBackgroundedAndroid.sandbox.__LIFELINE_APP_ACTIVE__, false, 'initial native background state is stored before the game bootstrap');
const backgroundDuringStartupLoad = await executeEntry({ harmony: false, capacitorNative: true, dispatchBackgroundDuringLoad: true });
assert.equal(backgroundDuringStartupLoad.sandbox.__LIFELINE_APP_ACTIVE__, false,
  'a background callback arriving during delayed native session loading remains available to App.setup');

const platformImportFailure = await executeEntry({ harmony: true, failPlatformModuleImport: true });
assertStartupFailureUi(platformImportFailure, [], []);
assert.deepEqual(platformImportFailure.calls, [], 'platform module import failure is caught before storage work');

const mainImportFailure = await executeEntry({ harmony: true, failMainImport: true });
assertStartupFailureUi(mainImportFailure, [], []);
assert.deepEqual(mainImportFailure.calls.map(({ operation }) => operation), ['loadRecord', 'loadRecord', 'claimCredentialOwner', 'loadCredential'],
  'credential initialization completes before the main module import is attempted');

const androidShareEntry = await executeEntry({ harmony: false, capacitorNative: true });
const androidPlatform = await androidShareEntry.loadPlatform();
const replayCodec = await androidShareEntry.loadReplayCodec();
const shareSession = await androidShareEntry.loadLocalSession();
assert.equal(shareSession.persistLocalGameSession(shareSession.createLocalGameSession({
  playerCount: 2, gridSize: 5, startPlayer: 'BLACK', rulesVersion: 'territory-v2',
})), true, 'the normal Android session writer remains available alongside replay sharing');
await androidShareEntry.sandbox.LifelinePlatform.flushSessionMirror();
const sessionBeforeSharing = {
  local: [...androidShareEntry.localValues.entries()],
  native: [...androidShareEntry.nativeValues.entries()],
};
const replayForShare = { format: 'lifeline-replay', schemaVersion: 1, text: '回放💩' };
assert.equal(await replayCodec.downloadReplayDocument(replayForShare), 'share-selected', 'actual built ReplayCodec distinguishes an Android target selection');
assert.equal(androidShareEntry.replayApiCalls.filter(({ plugin, method }) => plugin === 'Share' && method === 'share').length, 1);
const firstShareFile = androidShareEntry.replayApiCalls.find(({ plugin, method }) => plugin === 'Filesystem' && method === 'writeFile');
assert.equal(firstShareFile.args.directory, 'CACHE');
assert.equal(firstShareFile.args.encoding, 'utf8');
assert.equal(firstShareFile.args.recursive, true);
assert.match(firstShareFile.args.path, /^lifeline-replay-share\/replay-\d{13}-[a-f0-9]{32}\.json$/);
assert.equal(androidShareEntry.replayFiles.size, 1, 'successful shares remain in the bounded private cache for target reads');
assert.equal(androidShareEntry.replayApiCalls.some(({ plugin, method }) => plugin === 'Filesystem' && method === 'readdir' && method !== 'writeFile'), true);

androidShareEntry.setShareOutcome('cancel');
assert.equal(await replayCodec.downloadReplayDocument(replayForShare), 'cancelled', 'the installed Android SharePlugin cancellation becomes a normal outcome');
assert.equal(androidShareEntry.replayFiles.size, 1, 'confirmed cancellation removes its temporary file but preserves the earlier successful cache item');
androidShareEntry.setShareOutcome('returned');
assert.equal(await replayCodec.downloadReplayDocument(replayForShare), 'share-returned', 'an empty activityType is reported without inventing a selected target');
assert.deepEqual([...androidShareEntry.localValues.entries()], sessionBeforeSharing.local, 'export/cancel operations do not edit the saved game record');
assert.deepEqual([...androidShareEntry.nativeValues.entries()], sessionBeforeSharing.native, 'sharing does not enqueue native session writes');

const multiByteOversizeEntry = await executeEntry({ harmony: false, capacitorNative: true });
const multiByteCodec = await multiByteOversizeEntry.loadReplayCodec();
const multiByteOversize = { format: 'lifeline-replay', schemaVersion: 1, text: '💩'.repeat(1_000_000) };
assert.ok(new TextEncoder().encode(JSON.stringify(multiByteOversize)).length > 4_000_000);
await assert.rejects(multiByteCodec.downloadReplayDocument(multiByteOversize), /4,000,000/);
assert.equal(multiByteOversizeEntry.replayApiCalls.length, 0, 'UTF-8 oversize is rejected before cache reads or writes');
assert.equal(multiByteOversizeEntry.replayFiles.size, 0);

const failedWriteEntry = await executeEntry({ harmony: false, capacitorNative: true, failReplayWrite: true });
const failedWriteCodec = await failedWriteEntry.loadReplayCodec();
await assert.rejects(failedWriteCodec.downloadReplayDocument(replayForShare), /synthetic replay write failure/);
assert.equal(failedWriteEntry.replayFiles.size, 0, 'a partial write failure removes the unique incomplete file');
assert.equal(failedWriteEntry.replayApiCalls.some(({ plugin }) => plugin === 'Share'), false, 'SharePlugin is never called after a failed file write');

const activeShareEntry = await executeEntry({ harmony: false, capacitorNative: true, shareOutcome: 'pending' });
const activeShareCodec = await activeShareEntry.loadReplayCodec();
const timedShare = activeShareCodec.downloadReplayDocument(replayForShare);
await new Promise((resolve) => setImmediate(resolve));
for (let index = 0; index < 16; index += 1) await Promise.resolve();
assert.equal(activeShareEntry.replayApiCalls.some(({ plugin, method }) => plugin === 'Share' && method === 'share'), true, JSON.stringify(activeShareEntry.replayApiCalls));
assert.equal(activeShareEntry.replayFiles.size, 2, 'an on-disk active marker protects the file across WebView reloads');
await assert.rejects(activeShareCodec.downloadReplayDocument(replayForShare), /状态仍未确认/);
const uncertainShareFile = [...activeShareEntry.replayFiles.keys()][0];
activeShareEntry.fireShareTimeout(540_000);
await assert.rejects(timedShare, /面板可能仍打开/);
assert.equal(activeShareEntry.replayFiles.has(uncertainShareFile), true, 'timeout never deletes a file while the system may still read it');
await assert.rejects(activeShareCodec.downloadReplayDocument(replayForShare), /状态仍未确认/, 'the operation lock survives the UI timeout');
activeShareEntry.resolvePendingShare('com.example.receiver');
for (let index = 0; index < 16; index += 1) await Promise.resolve();
assert.equal(activeShareEntry.replayFiles.size, 1, 'a late native result removes the active marker but retains the bounded file');
activeShareEntry.setShareOutcome('selected');
assert.equal(await activeShareCodec.downloadReplayDocument(replayForShare), 'share-selected', 'a late genuine result releases the matching operation for retry');

const delayedPreparationEntry = await executeEntry({ harmony: false, capacitorNative: true, delayReplayWrite: true });
const delayedPreparationCodec = await delayedPreparationEntry.loadReplayCodec();
const delayedPreparation = delayedPreparationCodec.downloadReplayDocument(replayForShare);
await new Promise((resolve) => setImmediate(resolve));
for (let index = 0; index < 16; index += 1) await Promise.resolve();
delayedPreparationEntry.fireShareTimeout(30_000);
await assert.rejects(delayedPreparation, /尚未打开/);
await assert.rejects(delayedPreparationCodec.downloadReplayDocument(replayForShare), /面板尚未打开/,
  'while a timed-out preparation remains unsettled, a retry does not claim the system panel may be open');
delayedPreparationEntry.releaseReplayWrite();
for (let index = 0; index < 16; index += 1) await Promise.resolve();
assert.equal(delayedPreparationEntry.replayApiCalls.some(({ plugin, method }) => plugin === 'Share' && method === 'share'), false,
  'a file write that completes after the preparation timeout cannot open a late system panel');
assert.equal(delayedPreparationEntry.replayFiles.size, 0, 'late preparation cleanup removes the unshared file');

const cacheNow = Date.now();
const cachedFile = (createdAt, suffix, size = 64) => [`replay-${createdAt}-${suffix.padStart(32, '0')}.json`, { createdAt, size, data: '' }];
const cachePolicyEntry = await executeEntry({
  harmony: false,
  capacitorNative: true,
  initialReplayFiles: [
    cachedFile(cacheNow - 25 * 60 * 60 * 1000, '1'),
    cachedFile(cacheNow - 10 * 60 * 1000, '2'),
    cachedFile(cacheNow + 24 * 60 * 60 * 1000, '3'),
  ],
});
const cachePolicyCodec = await cachePolicyEntry.loadReplayCodec();
await cachePolicyCodec.downloadReplayDocument(replayForShare);
assert.equal(cachePolicyEntry.replayFiles.size, 3, 'expired entries are removed while recent and future-dated entries are preserved');
assert.equal([...cachePolicyEntry.replayFiles.keys()].some((name) => name.includes('00000000000000000000000000000001')), false);
assert.equal([...cachePolicyEntry.replayFiles.keys()].some((name) => name.includes('00000000000000000000000000000002')), true);
assert.equal([...cachePolicyEntry.replayFiles.keys()].some((name) => name.includes('00000000000000000000000000000003')), true, 'future timestamps survive clock rollback');

const fullCacheEntry = await executeEntry({
  harmony: false,
  capacitorNative: true,
  initialReplayFiles: Array.from({ length: 32 }, (_, index) => cachedFile(cacheNow - 2 * 60 * 60 * 1000 - index, String(index + 10))),
});
const fullCacheCodec = await fullCacheEntry.loadReplayCodec();
await fullCacheCodec.downloadReplayDocument(replayForShare);
assert.equal(fullCacheEntry.replayFiles.size, 32, 'capacity pressure evicts an old eligible file before adding a new one');
assert.ok(fullCacheEntry.replayApiCalls.filter(({ plugin, method }) => plugin === 'Filesystem' && method === 'deleteFile').length >= 1);

const protectedCacheEntry = await executeEntry({
  harmony: false,
  capacitorNative: true,
  initialReplayFiles: Array.from({ length: 32 }, (_, index) => cachedFile(cacheNow - 10 * 60 * 1000 - index, String(index + 50))),
});
const protectedCacheCodec = await protectedCacheEntry.loadReplayCodec();
await assert.rejects(protectedCacheCodec.downloadReplayDocument(replayForShare), /缓存暂满/);
assert.equal(protectedCacheEntry.replayFiles.size, 32, 'cache pressure preserves files inside the one-hour retention window');
assert.equal(protectedCacheEntry.replayApiCalls.some(({ plugin, method }) => plugin === 'Filesystem' && method === 'writeFile'), false);

const byteLimitedCacheEntry = await executeEntry({
  harmony: false,
  capacitorNative: true,
  initialReplayFiles: [cachedFile(cacheNow - 2 * 60 * 60 * 1000, 'b0', 128 * 1024 * 1024)],
});
const byteLimitedCodec = await byteLimitedCacheEntry.loadReplayCodec();
await byteLimitedCodec.downloadReplayDocument(replayForShare);
assert.equal(byteLimitedCacheEntry.replayFiles.size, 1, 'the 128 MiB byte ceiling evicts an eligible old file before adding a new one');
assert.ok(byteLimitedCacheEntry.replayApiCalls.some(({ plugin, method }) => plugin === 'Filesystem' && method === 'deleteFile'));

const orphanedActiveCacheEntry = await executeEntry({
  harmony: false,
  capacitorNative: true,
  initialReplayFiles: Array.from({ length: 32 }, (_, index) => {
    const [name, info] = cachedFile(cacheNow - 25 * 60 * 60 * 1000 - index, String(index + 100));
    return [[name, info], [`${name}.active`, { ...info, size: 6 }]];
  }).flat(),
});
const orphanedActiveCodec = await orphanedActiveCacheEntry.loadReplayCodec();
await orphanedActiveCodec.downloadReplayDocument(replayForShare);
assert.equal(orphanedActiveCacheEntry.replayFiles.size, 1,
  'expired on-disk active markers left by an older WebView are reclaimed with their expired replay files');
assert.equal([...orphanedActiveCacheEntry.replayFiles.keys()].some((name) => name.endsWith('.active')), false);

const markerOnlyCacheEntry = await executeEntry({
  harmony: false,
  capacitorNative: true,
  initialReplayFiles: [[`replay-${String(cacheNow).padStart(13, '0')}-${'a'.repeat(32)}.json.active`, { mtime: cacheNow, size: 6 }]],
});
const markerOnlyCodec = await markerOnlyCacheEntry.loadReplayCodec();
await markerOnlyCodec.downloadReplayDocument(replayForShare);
assert.equal([...markerOnlyCacheEntry.replayFiles.keys()].some((name) => name.endsWith('.active')), false,
  'a marker with no corresponding replay JSON is reclaimed');

const unownedMarkerNames = [
  'user-notes.active',
  'replay-personal.json.active',
  `replay-${String(cacheNow).padStart(13, '0')}-not-a-nonce.json.active`,
];
const unownedMarkerCacheEntry = await executeEntry({
  harmony: false,
  capacitorNative: true,
  initialReplayFiles: unownedMarkerNames.map((name) => [name, { mtime: cacheNow, size: 24 }]),
});
const unownedMarkerCodec = await unownedMarkerCacheEntry.loadReplayCodec();
await unownedMarkerCodec.downloadReplayDocument(replayForShare);
for (const name of unownedMarkerNames) {
  assert.equal(unownedMarkerCacheEntry.replayFiles.has(name), true, `unowned cache entry is preserved: ${name}`);
}

const pendingMarkerCacheEntry = await executeEntry({
  harmony: false,
  capacitorNative: true,
  initialReplayFiles: (() => {
    const [name, info] = cachedFile(cacheNow - 10 * 60 * 1000, 'cafe');
    return [[name, info], [`${name}.active`, { ...info, size: 6 }]];
  })(),
});
const pendingMarkerCodec = await pendingMarkerCacheEntry.loadReplayCodec();
await assert.rejects(pendingMarkerCodec.downloadReplayDocument(replayForShare), /未确认的系统分享/,
  'a live marker survives WebView reload and blocks a duplicate native chooser');
assert.equal(pendingMarkerCacheEntry.replayFiles.size, 2);
assert.equal(pendingMarkerCacheEntry.replayApiCalls.some(({ plugin, method }) => plugin === 'Share' && method === 'share'), false);

const repeatedShareEntry = await executeEntry({ harmony: false, capacitorNative: true });
const repeatedShareCodec = await repeatedShareEntry.loadReplayCodec();
let rejectedAfterCacheLimit = 0;
for (let index = 0; index < 40; index += 1) {
  try { await repeatedShareCodec.downloadReplayDocument(replayForShare); }
  catch (error) {
    assert.match(error.message, /缓存暂满/);
    rejectedAfterCacheLimit += 1;
  }
}
assert.equal(rejectedAfterCacheLimit, 8, 'repeated exports stop at the conservative 32-file cache bound');
assert.equal(repeatedShareEntry.replayFiles.size, 32);
assert.equal(new Set([...repeatedShareEntry.replayFiles.keys()].filter((name) => name.endsWith('.json'))).size, 32,
  'same-millisecond shares still receive unique filenames');
assert.deepEqual([...androidShareEntry.localValues.entries()], sessionBeforeSharing.local, 'share cache pressure leaves the preexisting saved session unchanged');
assert.deepEqual([...androidShareEntry.nativeValues.entries()], sessionBeforeSharing.native, 'share cache pressure does not touch native session persistence');

console.log('verify-mobile-entry-routing: PASS (generated entry and Android bridge, actual ReplayCodec export status, quota/cache/lifecycle mocks, original save preservation)');
