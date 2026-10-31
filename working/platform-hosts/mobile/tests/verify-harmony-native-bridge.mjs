import assert from 'node:assert/strict';
import { lstat, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { installHarmonyNativeBridge } from '../src/harmony-native-bridge.js';

const cliArgs = process.argv.slice(2);
let tombstoneReceiptTarget = null;
if (cliArgs.length > 0) {
  if (cliArgs.length !== 2 || cliArgs[0] !== '--tombstone-receipt' || cliArgs[1].startsWith('--')) {
    throw new Error('Usage: verify-harmony-native-bridge.mjs [--tombstone-receipt <new-json-path>]');
  }
  tombstoneReceiptTarget = resolve(cliArgs[1]);
  const parent = await stat(dirname(tombstoneReceiptTarget)).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error('Tombstone receipt parent directory must already exist.');
    throw error;
  });
  if (!parent.isDirectory()) throw new Error('Tombstone receipt parent path must be a directory.');
  try {
    await lstat(tombstoneReceiptTarget);
    throw new Error('Tombstone receipt target already exists; refusing to overwrite it.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function writeTombstoneReceipt() {
  if (tombstoneReceiptTarget === null) return;
  const receipt = {
    schema: 'lifeline-harmony-tombstone-load-host-verification-v1',
    status: 'PASS_HARMONY_TOMBSTONE_LOAD_HOST',
    generatedAt: new Date().toISOString(),
    argv: process.argv,
    targetPath: tombstoneReceiptTarget,
    source_sha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
    checks: [
      'missing_session_loads_as_null',
      'independent_facade_reads_shared_backing_map',
      'tombstone_loads_as_null_through_independent_facade',
      'read_and_flush_failures_fail_closed',
    ],
    scope: 'API-shaped host persistence model; not SDK compilation or device durability evidence',
  };
  await writeFile(tombstoneReceiptTarget, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(`verify-harmony-native-bridge: wrote host receipt ${tombstoneReceiptTarget}`);
}

const originalProxy = globalThis.LifelineArkTS;
const originalBridge = globalThis.LifelineBridge;
const originalComplete = globalThis.__lifelineNativeComplete;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const requests = [];
const timers = new Map();
const timerDelays = new Map();
let nextTimer = 0;
globalThis.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, callback); timerDelays.set(id, delay); return id; };
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.LifelineArkTS = { callNative: (...args) => requests.push(args) };

try {
  installHarmonyNativeBridge();
  const oldCompletion = globalThis.__lifelineNativeComplete;
  const oldPageLoad = globalThis.LifelineBridge.loadRecord('lifeline-local-game-session-v1');
  const oldRequestId = requests.at(-1)[0];
  installHarmonyNativeBridge();
  const newPageLoad = globalThis.LifelineBridge.loadRecord('lifeline-local-game-session-v1');
  const newRequestId = requests.at(-1)[0];
  assert.match(oldRequestId, /^[a-f0-9]{16}\.1$/);
  assert.match(newRequestId, /^[a-f0-9]{16}\.1$/);
  assert.notEqual(oldRequestId, newRequestId, 'each page instance has a distinct request nonce');

  globalThis.__lifelineNativeComplete(oldRequestId, JSON.stringify({ ok: true, result: { value: 'stale-save-result' } }));
  oldCompletion(newRequestId, JSON.stringify({ ok: true, result: { value: 'cross-page-result' } }));
  globalThis.__lifelineNativeComplete(newRequestId, JSON.stringify({ ok: true, result: { value: null } }));
  assert.deepEqual(await newPageLoad, { value: null }, 'unknown and late callbacks cannot resolve the current request');
  const oldTimerId = [...timers.keys()].at(-1);
  timers.get(oldTimerId)();
  await assert.rejects(oldPageLoad, /Harmony native request timed out: loadRecord/);

  const pending = globalThis.LifelineBridge.loadRecord('lifeline-local-game-session-v1');
  const timeoutRequestId = requests.at(-1)[0];
  const timerId = [...timers.keys()].at(-1);
  timers.get(timerId)();
  await assert.rejects(pending, /Harmony native request timed out: loadRecord/);
  globalThis.__lifelineNativeComplete(timeoutRequestId, JSON.stringify({ ok: true, result: { value: 'late' } }));

  const replay = { format: 'lifeline-replay', schemaVersion: 1, title: '回放' };
  const appInfoPromise = globalThis.LifelineBridge.getAppInfo();
  const appInfoRequest = requests.at(-1);
  assert.equal(appInfoRequest[1], 'getAppInfo', 'Harmony metadata uses a fixed bridge operation');
  assert.equal(appInfoRequest[2], '', 'the web caller cannot select a bundle or metadata key');
  globalThis.__lifelineNativeComplete(appInfoRequest[0], JSON.stringify({ ok: true, result: { version: '1.0.0', build: '1' } }));
  assert.deepEqual(await appInfoPromise, { version: '1.0.0', build: '1' });
  const capabilityPromise = globalThis.LifelineBridge.getCapabilities();
  const capabilityRequest = requests.at(-1);
  assert.equal(capabilityRequest[1], 'getCapabilities', 'capabilities use a fixed Harmony bridge operation');
  assert.equal(capabilityRequest[2], '', 'capability query does not accept a caller-selected key');
  assert.equal(capabilityRequest[3], '{"schemaVersion":1}', 'capability requests declare schema version 1');
  assert.equal(timerDelays.get([...timers.keys()].at(-1)), 5_000, 'capability query is bounded to five seconds');
  globalThis.__lifelineNativeComplete(capabilityRequest[0], JSON.stringify({ ok: true, result: { schemaVersion: 1, platform: 'harmonyos', source: 'harmony-native', capabilities: {} } }));
  assert.deepEqual(await capabilityPromise, { schemaVersion: 1, platform: 'harmonyos', source: 'harmony-native', capabilities: {} });
  const hapticPromise = globalThis.LifelineBridge.requestMoveHaptic();
  const hapticRequest = requests.at(-1);
  assert.deepEqual(hapticRequest.slice(1), ['requestMoveHaptic', '', ''], 'haptics uses a fixed parameter-free bridge operation');
  assert.equal(timerDelays.get([...timers.keys()].at(-1)), 5_000, 'haptic bridge has a bounded timeout');
  globalThis.__lifelineNativeComplete(hapticRequest[0], JSON.stringify({ ok: true, result: { status: 'requested' } }));
  assert.deepEqual(await hapticPromise, { status: 'requested' });
  const timedCapabilities = globalThis.LifelineBridge.getCapabilities();
  const timedCapabilityRequest = requests.at(-1);
  const capabilityTimeoutId = [...timers.keys()].at(-1);
  timers.get(capabilityTimeoutId)();
  await assert.rejects(timedCapabilities, /Harmony native request timed out: getCapabilities/);
  globalThis.__lifelineNativeComplete(timedCapabilityRequest[0], JSON.stringify({ ok: true, result: { schemaVersion: 1 } }));
  await assert.rejects(globalThis.LifelineBridge.shareReplay({ format: 'wrong', schemaVersion: 1 }), /Unsupported replay document/);
  const timerCountBeforeShare = timers.size;
  const shared = globalThis.LifelineBridge.shareReplay(replay);
  const shareRequestId = requests.at(-1)[0];
  assert.equal(timers.size, timerCountBeforeShare + 1, 'interactive share gets a handshake timeout independent of storage');
  const openedTimeoutId = [...timers.keys()].at(-1);
  const storageWhileSharePending = globalThis.LifelineBridge.loadRecord('lifeline-local-game-session-v1');
  const storageRequestId = requests.at(-1)[0];
  globalThis.__lifelineNativeComplete(storageRequestId, JSON.stringify({ ok: true, result: { value: null } }));
  assert.deepEqual(await storageWhileSharePending, { value: null }, 'storage callbacks remain live while share is pending');
  await assert.rejects(globalThis.LifelineBridge.shareReplay(replay), /already active/);
  globalThis.__lifelineNativeComplete(shareRequestId, JSON.stringify({ ok: true, result: { status: 'opened' } }));
  assert.equal(timers.size, timerCountBeforeShare + 1, 'open acknowledgement switches to the panel-close watchdog');
  globalThis.__lifelineNativeComplete(shareRequestId, JSON.stringify({ ok: true, result: { status: 'dismissed' } }));
  assert.deepEqual(await shared, { status: 'dismissed' }, 'the user-facing share result waits for panel closure and does not claim delivery');

  const timeoutShare = globalThis.LifelineBridge.shareReplay(replay);
  const timeoutShareId = requests.at(-1)[0];
  globalThis.__lifelineNativeComplete(timeoutShareId, JSON.stringify({ ok: true, result: { status: 'opened' } }));
  const panelTimeoutId = [...timers.keys()].at(-1);
  timers.get(panelTimeoutId)();
  timers.delete(panelTimeoutId);
  await assert.rejects(timeoutShare, /结果未知/, 'missing dismiss is reported as unknown completion');
  assert.notEqual(panelTimeoutId, openedTimeoutId, 'open acknowledgement replaces the initial handshake deadline');
  const afterDismissTimeout = globalThis.LifelineBridge.shareReplay(replay);
  const afterDismissTimeoutId = requests.at(-1)[0];
  globalThis.__lifelineNativeComplete(timeoutShareId, JSON.stringify({ ok: true, result: { status: 'dismissed' } }));
  await assert.rejects(globalThis.LifelineBridge.shareReplay(replay), /already active/, 'a late old receipt cannot release a newer request lock');
  globalThis.__lifelineNativeComplete(afterDismissTimeoutId, JSON.stringify({ ok: false, error: 'retry allowed' }));
  await assert.rejects(afterDismissTimeout, /retry allowed/);

  const lostOpenedReceipt = globalThis.LifelineBridge.shareReplay(replay);
  const lostOpenedId = requests.at(-1)[0];
  globalThis.__lifelineNativeComplete(lostOpenedId, JSON.stringify({ ok: true, result: { status: 'dismissed' } }));
  await assert.rejects(lostOpenedReceipt, /did not confirm.*opened/, 'dismiss without an opened receipt is not reported as success');

  const failedShare = globalThis.LifelineBridge.shareReplay(replay);
  const failedRequestId = requests.at(-1)[0];
  globalThis.__lifelineNativeComplete(failedRequestId, JSON.stringify({ ok: false, error: 'Share Kit unavailable.' }));
  await assert.rejects(failedShare, /Share Kit unavailable/);
  const reopenedShare = globalThis.LifelineBridge.shareReplay(replay);
  const reopenedRequestId = requests.at(-1)[0];
  globalThis.__lifelineNativeComplete(reopenedRequestId, JSON.stringify({ ok: true, result: { status: 'opened' } }));
  globalThis.__lifelineNativeComplete(reopenedRequestId, JSON.stringify({ ok: false, error: 'late native failure' }));
  await assert.rejects(reopenedShare, /结果未知/, 'failure after open is observable through the export promise');
  const afterLateFailure = globalThis.LifelineBridge.shareReplay(replay);
  const afterLateFailureId = requests.at(-1)[0];
  globalThis.__lifelineNativeComplete(afterLateFailureId, JSON.stringify({ ok: false, error: 'closed' }));
  await assert.rejects(afterLateFailure, /closed/);
  const malformedAfterOpen = globalThis.LifelineBridge.shareReplay(replay);
  const malformedAfterOpenId = requests.at(-1)[0];
  globalThis.__lifelineNativeComplete(malformedAfterOpenId, JSON.stringify({ ok: true, result: { status: 'opened' } }));
  globalThis.__lifelineNativeComplete(malformedAfterOpenId, '{bad json');
  await assert.rejects(malformedAfterOpen, SyntaxError, 'a malformed receipt after open rejects the waiting export promise');
  const afterMalformedReceipt = globalThis.LifelineBridge.shareReplay(replay);
  const afterMalformedReceiptId = requests.at(-1)[0];
  globalThis.__lifelineNativeComplete(afterMalformedReceiptId, JSON.stringify({ ok: false, error: 'retry after malformed receipt' }));
  await assert.rejects(afterMalformedReceipt, /retry after malformed receipt/, 'malformed receipt cleanup releases the bridge request lock');
  const openLostShare = globalThis.LifelineBridge.shareReplay(replay);
  const openLostId = requests.at(-1)[0];
  const openTimeoutId = [...timers.keys()].at(-1);
  timers.get(openTimeoutId)();
  timers.delete(openTimeoutId);
  await assert.rejects(openLostShare, /面板仍可能出现/);
  const afterOpenTimeout = globalThis.LifelineBridge.shareReplay(replay);
  const afterOpenTimeoutId = requests.at(-1)[0];
  globalThis.__lifelineNativeComplete(openLostId, JSON.stringify({ ok: true, result: { status: 'opened' } }));
  await assert.rejects(globalThis.LifelineBridge.shareReplay(replay), /already active/, 'late opened callback after handshake timeout cannot unlock a newer request');
  globalThis.__lifelineNativeComplete(afterOpenTimeoutId, JSON.stringify({ ok: false, error: 'retry complete' }));
  await assert.rejects(afterOpenTimeout, /retry complete/);

  const importPromise = globalThis.LifelineBridge.importReplay();
  const importRequest = requests.at(-1);
  assert.deepEqual(importRequest.slice(1), ['importReplay', '', ''], 'Harmony replay import uses a fixed parameter-free bridge operation');
  assert.equal(timers.size, timerCountBeforeShare, 'the system picker does not expire while the user is choosing a document');
  globalThis.__lifelineNativeComplete(importRequest[0], JSON.stringify({ ok: true, result: { status: 'selected', text: '{"format":"lifeline-replay"}' } }));
  assert.deepEqual(await importPromise, { status: 'selected', text: '{"format":"lifeline-replay"}' });
  console.log('verify-harmony-native-bridge: PASS (per-page nonce, storage timeout isolation, replay share lifecycle and stale callbacks)');
} finally {
  globalThis.LifelineArkTS = originalProxy;
  globalThis.LifelineBridge = originalBridge;
  globalThis.__lifelineNativeComplete = originalComplete;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

const nativeSource = await readFile(new URL('../harmony/entry/src/main/ets/bridge/LifelineNativeProxy.ets', import.meta.url), 'utf8');
const nativeJavaScript = ts.transpileModule(
  nativeSource.split(/\r?\n/).filter((line) => !line.startsWith('import ')).join('\n'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText;

function createNativeHarness({ shortWrite = false, now = 1_800_000_000_000, show = () => Promise.resolve(), generation = () => 0, foreground = true,
  selectFiles = async () => [],
  vibratorStart = async () => {},
  getBundleInfoForSelf = async () => ({ versionName: '1.0.0', versionCode: 1 }),
  store = { has: async () => false, get: async (_key, fallback) => fallback, put: async () => {}, delete: async () => {}, flush: async () => {} } } = {}) {
  const files = new Map();
  const descriptors = new Map();
  const importFiles = new Map();
  const replies = [];
  const timers = new Map();
  const shareControllers = [];
  let directoryExists = false;
  let nextFd = 0;
  let nextTimer = 0;
  let accessCalls = 0;
  let openCalls = 0;
  let writeCalls = 0;
  let importFd = 0;
  const importDescriptors = new Map();
  const nativeFileIo = {
    OpenMode: { CREATE: 1, READ_WRITE: 2, TRUNC: 4, READ_ONLY: 8 },
    accessSync(path) {
      accessCalls += 1;
      if (path === '/cache/lifeline-replay-share') return directoryExists;
      return files.has(path);
    },
    mkdirSync(path) { assert.equal(path, '/cache/lifeline-replay-share'); directoryExists = true; },
    listFileSync(path) { assert.equal(path, '/cache/lifeline-replay-share'); return [...files.keys()].map((file) => file.slice(file.lastIndexOf('/') + 1)); },
    openSync(path, mode) {
      assert.equal(typeof mode, 'number');
      openCalls += 1;
      const file = { fd: ++nextFd, path };
      descriptors.set(file.fd, file);
      files.set(path, '');
      return file;
    },
    writeSync(fd, value, options) {
      assert.equal(typeof fd, 'number', 'writeSync receives File.fd per the official API signature');
      assert.equal(options.encoding, 'utf-8');
      writeCalls += 1;
      const bytes = Buffer.from(value, 'utf8');
      const written = shortWrite ? bytes.length - 1 : bytes.length;
      files.set(descriptors.get(fd).path, bytes.subarray(0, written).toString('utf8'));
      return written;
    },
    closeSync(fd) { assert.equal(typeof fd, 'number'); descriptors.delete(fd); },
    unlinkSync(path) { files.delete(path); },
    statSync(path) { return { size: Buffer.byteLength(files.get(path) ?? '', 'utf8') }; },
    async stat(uri) { const bytes = importFiles.get(uri); if (!bytes) throw new Error('missing'); return { size: bytes.length }; },
    async open(uri, mode) { assert.equal(mode, 8); if (!importFiles.has(uri)) throw new Error('missing'); const fd = ++importFd; importDescriptors.set(fd, { uri, position: 0 }); return { fd }; },
    async read(fd, buffer, options) {
      const descriptor = importDescriptors.get(fd);
      const bytes = importFiles.get(descriptor.uri);
      const start = options.offset ?? descriptor.position;
      const count = Math.min(options.length, Math.max(0, bytes.length - start));
      new Uint8Array(buffer, 0, count).set(bytes.subarray(start, start + count));
      descriptor.position += count;
      return count;
    },
    async close(fd) { importDescriptors.delete(fd); },
  };
  const nativePicker = { DocumentViewPicker: class {
    constructor(value) { this.context = value; }
    select(options) { return selectFiles(options); }
  } };
  const shareApi = {
    SharedData: class { constructor(value) { this.value = value; } },
    ShareController: class {
      constructor(data) { this.data = data; this.listeners = new Map(); shareControllers.push(this); }
      on(event, callback) { this.listeners.set(event, callback); }
      off(event, callback) { if (this.listeners.get(event) === callback) this.listeners.delete(event); }
      show(context, options) { this.context = context; this.options = options; return show(this); }
      dismiss() { this.listeners.get('dismiss')?.(); }
    },
    SelectionMode: { SINGLE: 'single' },
    SharePreviewMode: { DEFAULT: 'default' },
  };
  const mockExports = {};
  const module = { exports: mockExports };
  new Function('exports', 'fileIo', 'fileUri', 'utd', 'systemShare', 'url', 'bundleManager', 'vibrator', 'WebControllerRegistry', 'picker', 'util', 'console', 'setTimeout', 'clearTimeout', 'Date', nativeJavaScript)(
    mockExports,
    nativeFileIo,
    { getUriFromPath: (path) => `file://${path}` },
    { getUniformDataTypeByFilenameExtension: (ext, type) => `${type}${ext}`, UniformDataType: { TEXT: 'text' } },
    shareApi,
    { URL },
    { BundleFlag: { GET_BUNDLE_INFO_DEFAULT: 0 }, getBundleInfoForSelf },
    { startVibration: vibratorStart },
    { isCurrentGeneration: (_controller, requested) => requested === generation(), currentGeneration: (_controller) => generation(), isForeground: () => foreground },
    nativePicker,
    { TextDecoder: { create: (_encoding, options) => ({ decodeToString: (bytes) => new TextDecoder('utf-8', options).decode(bytes) }) } },
    console,
    (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    (id) => timers.delete(id),
    { now: () => now },
  );
  const controller = {
    getLastJavascriptProxyCallingFrameUrl: () => 'https://lifeline.appassets.invalid/index.html',
    runJavaScript: async (script) => {
      vm.runInNewContext(script, { globalThis: { __lifelineNativeComplete: (id, response) => replies.push({ id, response: JSON.parse(response) }) } });
    },
  };
  let backgroundCalls = 0;
  const context = { cacheDir: '/cache', moveAbilityToBackground: async () => { backgroundCalls += 1; } };
  const createProxy = (proxyGeneration = generation, proxyStore = store) => new module.exports.LifelineNativeProxy(proxyStore, controller, context, proxyGeneration);
  const proxy = createProxy();
  return { files, descriptors, replies, timers, shareControllers, importFiles, proxy, createProxy, stats: () => ({ directoryExists, accessCalls, openCalls, writeCalls, backgroundCalls, importDescriptors: importDescriptors.size }) };
}

async function flushNativeMicrotasks(count = 8) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

function cachedReplayCount(files) {
  return [...files.keys()].filter((path) => /replay-.*\.json$/.test(path)).length;
}

const sessionDisk = new Map();
let rejectSessionRead = false;
let rejectSessionFlush = false;
const createSessionPreferencesFacade = () => {
  const pending = new Map();
  return {
    has: async (key) => sessionDisk.has(key),
    get: async (key, fallback) => {
      if (rejectSessionRead) throw new Error('simulated Preferences read failure');
      if (!sessionDisk.has(key)) return fallback;
      const stored = sessionDisk.get(key);
      return typeof stored === 'string' ? stored : fallback;
    },
    put: async (key, value) => { pending.set(key, value); },
    delete: async (key) => { pending.set(key, undefined); },
    flush: async () => {
      if (rejectSessionFlush) throw new Error('simulated Preferences flush failure');
      for (const [key, value] of pending) {
        if (value === undefined) sessionDisk.delete(key);
        else sessionDisk.set(key, value);
      }
      pending.clear();
    },
  };
};
const sessionStoreHarness = createNativeHarness();
const sessionPreferencesFacadeA = createSessionPreferencesFacade();
const sessionPreferencesFacadeB = createSessionPreferencesFacade();
let sessionRequestNumber = 0;
const requestNativeStorage = async (proxy, id, operation, value = '') => {
  const requestId = `abababababababab.${++sessionRequestNumber}`;
  proxy.callNative(requestId, operation, 'lifeline-local-game-session-v1', value);
  await flushNativeMicrotasks(25);
  return sessionStoreHarness.replies.find((reply) => reply.id === requestId)?.response;
};
const sessionProxyA = sessionStoreHarness.createProxy(undefined, sessionPreferencesFacadeA);
assert.deepEqual(await requestNativeStorage(sessionProxyA, 'session.1', 'loadRecord'),
  { ok: true, result: { value: null } }, 'missing Harmony session reads as null in the API-shaped host persistence model');
const sessionPayload = '{"format":"lifeline-session","step":7}';
assert.deepEqual(await requestNativeStorage(sessionProxyA, 'session.2', 'saveRecord', sessionPayload),
  { ok: true, result: { flushed: true } }, 'save and same-facade flush readback pass in the API-shaped host persistence model');
const sessionProxyB = sessionStoreHarness.createProxy(undefined, sessionPreferencesFacadeB);
assert.deepEqual(await requestNativeStorage(sessionProxyB, 'session.3', 'loadRecord'),
  { ok: true, result: { value: sessionPayload } }, 'an independent facade and proxy can read the flushed value from the shared host backing map');
sessionDisk.set('lifeline-local-game-session-v1', '{broken-json');
assert.deepEqual(await requestNativeStorage(sessionProxyB, 'session.4', 'loadRecord'),
  { ok: true, result: { value: '{broken-json' } }, 'malformed host-model data remains distinguishable from missing data for recovery validation');
rejectSessionRead = true;
assert.equal((await requestNativeStorage(sessionProxyB, 'session.5', 'loadRecord')).ok, false,
  'Preferences read failures fail closed in the host model');
rejectSessionRead = false;
rejectSessionFlush = true;
assert.equal((await requestNativeStorage(sessionProxyB, 'session.6', 'saveRecord', sessionPayload)).ok, false,
  'flush failure is not reported as a successful save in the host model');
assert.equal((await requestNativeStorage(sessionProxyB, 'session.7', 'removeRecord')).ok, false,
  'flush failure is not reported as a successful clear in the host model');
rejectSessionFlush = false;
assert.deepEqual(await requestNativeStorage(sessionProxyA, 'session.8', 'removeRecord'),
  { ok: true, result: { flushed: true } }, 'clear flushes and reads back the tombstone using the same facade');
assert.deepEqual(await requestNativeStorage(sessionProxyB, 'session.9', 'loadRecord'),
  { ok: true, result: { value: null } }, 'the tombstone maps to null through an independent facade and proxy in the API-shaped host model');
const savedSessionBeforeInvalidType = sessionDisk.get('lifeline-local-game-session-v1');
const invalidSessionValue = { unexpected: 'object' };
for (const [invalidIndex, invalidValue] of [null, invalidSessionValue].entries()) {
  sessionDisk.set('lifeline-local-game-session-v1', invalidValue);
  assert.equal((await requestNativeStorage(sessionProxyB, `session.${10 + invalidIndex * 3}`, 'loadRecord')).ok, false,
    'null and non-string Preferences values map to the sentinel and fail closed on load');
  assert.equal((await requestNativeStorage(sessionProxyA, `session.${11 + invalidIndex * 3}`, 'saveRecord', sessionPayload)).ok, false,
    'save refuses to mutate a null or non-string previous snapshot');
  assert.equal((await requestNativeStorage(sessionProxyB, `session.${12 + invalidIndex * 3}`, 'removeRecord')).ok, false,
    'clear refuses to mutate a null or non-string previous snapshot');
  assert.equal(sessionDisk.get('lifeline-local-game-session-v1'), invalidValue,
    'invalid values are not silently stringified, overwritten, or treated as missing');
}
sessionDisk.set('lifeline-local-game-session-v1', savedSessionBeforeInvalidType);

let invalidReadbackCount = 0;
let invalidReadbackDurable = '{"format":"lifeline-session","step":31}';
let invalidReadbackPending = invalidReadbackDurable;
const invalidReadbackStore = {
  has: async () => true,
  get: async (_key, fallback) => {
    invalidReadbackCount += 1;
    if (invalidReadbackCount === 2) return fallback;
    return invalidReadbackDurable ?? fallback;
  },
  put: async (_key, value) => { invalidReadbackPending = value; },
  delete: async () => { invalidReadbackPending = undefined; },
  flush: async () => { invalidReadbackDurable = invalidReadbackPending; },
};
const invalidReadbackHarness = createNativeHarness({ store: invalidReadbackStore });
const invalidReadbackProxy = invalidReadbackHarness.createProxy(() => 0, invalidReadbackStore);
invalidReadbackProxy.callNative('abababababababac.1', 'saveRecord', 'lifeline-local-game-session-v1', sessionPayload);
await flushNativeMicrotasks(25);
assert.equal(invalidReadbackHarness.replies[0].response.ok, false,
  'a has/get default-sentinel mismatch during post-write verification rejects the save');
assert.equal(invalidReadbackDurable, '{"format":"lifeline-session","step":31}',
  'non-string verification readback still rolls back and verifies the prior snapshot');


async function verifyStaleSessionMutation(operation, replacementValue, delayedStage = 'put') {
  let pageGeneration = 41;
  let durableValue = '{"format":"lifeline-session","step":6}';
  let durableExists = true;
  let pendingValue = durableValue;
  let pendingExists = true;
  let releaseGate;
  let enteredGate;
  const gateStarted = new Promise((resolve) => { enteredGate = resolve; });
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  let puts = 0;
  let gets = 0;
  const store = {
    has: async () => durableExists,
    get: async (_key, fallback) => {
      gets += 1;
      if (delayedStage === 'readback' && gets === 2) { enteredGate(); await gate; }
      return durableExists ? durableValue : fallback;
    },
    put: async (_key, value) => {
      puts += 1;
      pendingValue = value;
      pendingExists = true;
      if (delayedStage === 'put' && puts === 1) { enteredGate(); await gate; }
    },
    delete: async () => { pendingExists = false; pendingValue = undefined; },
    flush: async () => { durableValue = pendingValue; durableExists = pendingExists; },
  };
  const harness = createNativeHarness({ generation: () => pageGeneration, store });
  const oldProxy = harness.createProxy(() => pageGeneration, store);
  const oldId = 'abababababababab.41';
  oldProxy.callNative(oldId, operation, 'lifeline-local-game-session-v1', replacementValue);
  await gateStarted;
  pageGeneration = 42;
  const currentProxy = harness.createProxy(() => pageGeneration, store);
  const newId = 'abababababababab.42';
  currentProxy.callNative(newId, 'loadRecord', 'lifeline-local-game-session-v1', '');
  releaseGate();
  await flushNativeMicrotasks(50);
  assert.equal(durableValue, '{"format":"lifeline-session","step":6}', `${operation} from the old page is rolled back before the replacement page reads`);
  assert.equal(durableExists, true, `${operation} restores the original key presence`);
  assert.deepEqual(harness.replies.find(({ id }) => id === newId)?.response,
    { ok: true, result: { value: durableValue } }, 'the replacement page read waits behind the old operation and sees the preserved session');
  assert.equal(harness.replies.some(({ id }) => id === oldId), false, 'old-generation storage completion is never published to a page');
}
await verifyStaleSessionMutation('saveRecord', '{"format":"lifeline-session","step":99}');
await verifyStaleSessionMutation('removeRecord', '');
await verifyStaleSessionMutation('saveRecord', '{"format":"lifeline-session","step":100}', 'readback');

let absentPageGeneration = 51;
let absentDurableExists = false;
let absentPendingValue;
let releaseAbsentFlush;
let enteredAbsentFlush;
const absentFlushStarted = new Promise((resolve) => { enteredAbsentFlush = resolve; });
const absentFlushGate = new Promise((resolve) => { releaseAbsentFlush = resolve; });
let absentFlushCount = 0;
const absentStore = {
  has: async () => absentDurableExists,
  get: async (_key, fallback) => absentDurableExists ? absentPendingValue : fallback,
  put: async (_key, value) => { absentPendingValue = value; absentDurableExists = true; },
  delete: async () => { absentPendingValue = undefined; absentDurableExists = false; },
  flush: async () => {
    absentFlushCount += 1;
    if (absentFlushCount === 1) { enteredAbsentFlush(); await absentFlushGate; }
    if (absentPendingValue === undefined) absentDurableExists = false;
    else absentDurableExists = true;
  },
};
const absentHarness = createNativeHarness({ generation: () => absentPageGeneration, store: absentStore });
const absentOldProxy = absentHarness.createProxy(() => absentPageGeneration, absentStore);
absentOldProxy.callNative('abababababababac.51', 'removeRecord', 'lifeline-local-game-session-v1', '');
await absentFlushStarted;
absentPageGeneration = 52;
const absentNewProxy = absentHarness.createProxy(() => absentPageGeneration, absentStore);
absentNewProxy.callNative('abababababababac.52', 'loadRecord', 'lifeline-local-game-session-v1', '');
releaseAbsentFlush();
await flushNativeMicrotasks(50);
assert.equal(absentDurableExists, false, 'rollback of a clear whose original key was absent deletes the key and flushes');
assert.deepEqual(absentHarness.replies.find(({ id }) => id === 'abababababababac.52')?.response,
  { ok: true, result: { value: null } }, 'the next queued reader confirms the originally absent key remains absent');

let sentinelFacadeReads = 0;
const sentinelMappedStore = {
  has: async () => true,
  get: async (_key, fallback) => { sentinelFacadeReads += 1; return fallback; },
  put: async () => {}, delete: async () => {}, flush: async () => {},
};
const sentinelHarness = createNativeHarness({ store: sentinelMappedStore });
const sentinelProxy = sentinelHarness.createProxy(() => 0, sentinelMappedStore);
sentinelProxy.callNative('abababababababad.1', 'loadRecord', 'lifeline-local-game-session-v1', '');
await flushNativeMicrotasks(25);
assert.equal(sentinelHarness.replies[0].response.ok, false, 'an existing key mapped to the unique get default sentinel fails closed');
assert.equal(sentinelFacadeReads, 1, 'an existing key is read exactly once with its sentinel default');

const validReplay = JSON.stringify({ format: 'lifeline-replay', schemaVersion: 1, text: '回放' });
let releaseBundleInfo;
const isolatedSequence = [];
let storedSession = '';
let releaseFirstFlush;
let firstFlushStarted;
const firstFlushEntered = new Promise((resolve) => { firstFlushStarted = resolve; });
const firstFlushGate = new Promise((resolve) => { releaseFirstFlush = resolve; });
let flushCount = 0;
const labelStoredSession = () => storedSession === '__lifeline_native_session_cleared_v1__'
  ? 'clear'
  : storedSession === '' ? 'empty' : JSON.parse(storedSession).step;
const metadataIsolation = createNativeHarness({
  getBundleInfoForSelf: () => new Promise((resolve) => { releaseBundleInfo = resolve; }),
  store: {
    has: async () => true,
    get: async () => { isolatedSequence.push(`get:${labelStoredSession()}`); return storedSession; },
    put: async (_key, value) => { storedSession = value; isolatedSequence.push(`put:${labelStoredSession()}`); },
    flush: async () => {
      const label = labelStoredSession();
      isolatedSequence.push(`flush:start:${label}`);
      flushCount += 1;
      if (flushCount === 1) { firstFlushStarted(); await firstFlushGate; }
      isolatedSequence.push(`flush:end:${label}`);
    },
  },
});
metadataIsolation.proxy.callNative('aaaaaaaaaaaaaaaa.1', 'getAppInfo', '', '');
metadataIsolation.proxy.callNative('aaaaaaaaaaaaaaaa.2', 'saveRecord', 'lifeline-local-game-session-v1', '{"step":1}');
await flushNativeMicrotasks();
await firstFlushEntered;
metadataIsolation.proxy.callNative('aaaaaaaaaaaaaaaa.3', 'saveRecord', 'lifeline-local-game-session-v1', '{"step":2}');
metadataIsolation.proxy.callNative('aaaaaaaaaaaaaaaa.4', 'removeRecord', 'lifeline-local-game-session-v1', '');
await flushNativeMicrotasks();
assert.deepEqual(isolatedSequence, ['get:empty', 'put:1', 'flush:start:1'], 'later persistence waits for the active flush');
releaseFirstFlush();
await flushNativeMicrotasks(40);
assert.deepEqual(isolatedSequence, [
  'get:empty', 'put:1', 'flush:start:1', 'flush:end:1', 'get:1',
  'get:1', 'put:2', 'flush:start:2', 'flush:end:2', 'get:2',
  'get:2', 'put:clear', 'flush:start:clear', 'flush:end:clear', 'get:clear',
], 'save, save, and remove preserve their complete serialized put/flush/read-back order');
for (const id of ['aaaaaaaaaaaaaaaa.2', 'aaaaaaaaaaaaaaaa.3', 'aaaaaaaaaaaaaaaa.4']) {
  assert.equal(metadataIsolation.replies.find(({ id: replyId }) => replyId === id).response.ok, true,
    `queued persistence request ${id} completes while metadata is unresolved`);
}
releaseBundleInfo({ versionName: '1.0.0', versionCode: 1 });
await flushNativeMicrotasks();
assert.deepEqual(metadataIsolation.replies.find(({ id }) => id === 'aaaaaaaaaaaaaaaa.1').response,
  { ok: true, result: { version: '1.0.0', build: '1' } }, 'metadata callback still completes after its dependency resolves');

const appInfoHarness = createNativeHarness();
appInfoHarness.proxy.callNative('aaaaaaaaaaaaaaaa.1', 'getAppInfo', '', '');
await flushNativeMicrotasks();
assert.deepEqual(appInfoHarness.replies[0].response, { ok: true, result: { version: '1.0.0', build: '1' } }, 'native metadata is read from the app own bundle');
appInfoHarness.proxy.callNative('aaaaaaaaaaaaaaaa.2', 'getAppInfo', 'other.bundle', '');
await flushNativeMicrotasks();
assert.equal(appInfoHarness.replies[1].response.ok, false, 'metadata operation rejects caller-supplied package identifiers');
const nativeCapabilities = createNativeHarness();
nativeCapabilities.proxy.callNative('bbbbbbbbbbbbbbbb.1', 'getCapabilities', '', '{"schemaVersion":1}');
await flushNativeMicrotasks();
assert.equal(nativeCapabilities.replies[0].response.result.schemaVersion, 1);
assert.equal(nativeCapabilities.replies[0].response.result.capabilities.sessionStorage.support, 'implemented');
assert.equal(nativeCapabilities.replies[0].response.result.capabilities.haptics.support, 'implemented');
assert.equal(nativeCapabilities.replies[0].response.result.capabilities.replayImport.support, 'implemented');
assert.equal(nativeCapabilities.replies[0].response.result.capabilities.tutorialHost.support, 'implemented');
nativeCapabilities.proxy.callNative('bbbbbbbbbbbbbbbb.2', 'getCapabilities', '', '{"schemaVersion":2}');
await flushNativeMicrotasks();
assert.equal(nativeCapabilities.replies[1].response.ok, false, 'unsupported capability schema is rejected');
let releaseVibration;
let vibrationRequest;
const haptics = createNativeHarness({
  vibratorStart: (request, options) => {
    vibrationRequest = { request, options };
    return new Promise((resolve) => { releaseVibration = resolve; });
  },
});
haptics.proxy.callNative('cccccccccccccccc.1', 'requestMoveHaptic', '', '');
await flushNativeMicrotasks();
assert.deepEqual(vibrationRequest, { request: { type: 'time', duration: 24 }, options: { usage: 'touch' } }, 'native haptics uses only the fixed short touch vibration');
haptics.proxy.callNative('cccccccccccccccc.2', 'requestMoveHaptic', '', '');
assert.deepEqual(haptics.replies.find(({ id }) => id === 'cccccccccccccccc.2').response, { ok: true, result: { status: 'suppressed' } }, 'concurrent haptics are suppressed');
releaseVibration();
await flushNativeMicrotasks();
assert.deepEqual(haptics.replies.find(({ id }) => id === 'cccccccccccccccc.1').response, { ok: true, result: { status: 'requested' } });
const backgroundHaptics = createNativeHarness({ foreground: false, vibratorStart: async () => { throw new Error('must not vibrate while backgrounded'); } });
backgroundHaptics.proxy.callNative('dddddddddddddddd.1', 'requestMoveHaptic', '', '');
await flushNativeMicrotasks();
assert.deepEqual(backgroundHaptics.replies[0].response, { ok: true, result: { status: 'suppressed' } }, 'background lifecycle suppresses haptics before device dispatch');
let finishOldPageVibration;
const oldHapticsProxy = createNativeHarness({ vibratorStart: () => new Promise((resolve) => { finishOldPageVibration = resolve; }) });
oldHapticsProxy.proxy.callNative('1212121212121212.1', 'requestMoveHaptic', '', '');
await flushNativeMicrotasks();
const replacementHapticsProxy = oldHapticsProxy.createProxy();
replacementHapticsProxy.callNative('1313131313131313.1', 'requestMoveHaptic', '', '');
assert.deepEqual(oldHapticsProxy.replies.at(-1).response, { ok: true, result: { status: 'suppressed' } }, 'a replacement page proxy cannot overlap a native haptic still pending on the old page');
finishOldPageVibration();
await flushNativeMicrotasks();
let requestGeneration = 7;
const staleBackground = createNativeHarness({ generation: () => requestGeneration });
staleBackground.proxy.callNative('dddddddddddddddd.1', 'moveToBackground', '', '');
requestGeneration += 1;
await flushNativeMicrotasks();
assert.equal(staleBackground.stats().backgroundCalls, 0, 'a queued background request cannot move a newer page generation');
assert.equal(staleBackground.replies.some(({ id }) => id === 'dddddddddddddddd.1'), false, 'a stale old-page completion is dropped rather than published');
const background = createNativeHarness();
background.proxy.callNative('eeeeeeeeeeeeeeee.1', 'moveToBackground', '', '');
await flushNativeMicrotasks();
assert.equal(background.stats().backgroundCalls, 1, 'a current page can request the supported background API');
assert.deepEqual(background.replies[0].response.result, { moved: true });

const harmonyImportOptions = [];
const nativeImport = createNativeHarness({ selectFiles: async (options) => { harmonyImportOptions.push(options); return ['private://uri']; } });
  nativeImport.importFiles.set('private://uri', Buffer.from(validReplay, 'utf8'));
nativeImport.proxy.callNative('eeeeeeeeeeeeeeee.10', 'importReplay', '', '');
await flushNativeMicrotasks(25);
assert.deepEqual(harmonyImportOptions, [{ fileSuffixFilters: ['.json'], maxSelectNumber: 1 }], 'Harmony uses the official single JSON document picker');
assert.deepEqual(nativeImport.replies.find(({ id }) => id === 'eeeeeeeeeeeeeeee.10').response, {
  ok: true, result: { status: 'selected', text: validReplay },
}, 'Harmony sends only decoded replay text to the Web layer');
assert.equal(nativeImport.stats().importDescriptors, 0, 'the Harmony input descriptor is closed');
assert.doesNotMatch(JSON.stringify(nativeImport.replies), /private:\/\/uri/, 'the picker URI is never returned to the Web layer');

const longReplayText = `{"format":"lifeline-replay","schemaVersion":1,"data":"${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(4_000)}"}`;
const longNativeImport = createNativeHarness({ selectFiles: async () => ['private://long'] });
longNativeImport.importFiles.set('private://long', Buffer.from(longReplayText, 'utf8'));
longNativeImport.proxy.callNative('eeeeeeeeeeeeeeee.15', 'importReplay', '', '');
await flushNativeMicrotasks(40);
assert.equal(longNativeImport.replies[0].response.result.text, longReplayText, 'multi-chunk Harmony reads preserve source offsets and byte order');

const nativeImportCancel = createNativeHarness({ selectFiles: async () => [] });
nativeImportCancel.proxy.callNative('eeeeeeeeeeeeeeee.11', 'importReplay', '', '');
await flushNativeMicrotasks(20);
assert.deepEqual(nativeImportCancel.replies[0].response, { ok: true, result: { status: 'cancelled' } });

const nativeImportLarge = createNativeHarness({ selectFiles: async () => ['private://huge'] });
nativeImportLarge.importFiles.set('private://huge', Buffer.alloc(4_000_001, 65));
nativeImportLarge.proxy.callNative('eeeeeeeeeeeeeeee.12', 'importReplay', '', '');
await flushNativeMicrotasks(20);
assert.deepEqual(nativeImportLarge.replies[0].response, { ok: true, result: { status: 'too-large' } });
assert.equal(nativeImportLarge.stats().importDescriptors, 0, 'oversized Harmony files are rejected before opening');

const nativeImportInvalidUtf8 = createNativeHarness({ selectFiles: async () => ['private://bad-utf8'] });
nativeImportInvalidUtf8.importFiles.set('private://bad-utf8', Buffer.from([0xc3, 0x28]));
nativeImportInvalidUtf8.proxy.callNative('eeeeeeeeeeeeeeee.13', 'importReplay', '', '');
await flushNativeMicrotasks(20);
assert.equal(nativeImportInvalidUtf8.replies[0].response.ok, false, 'malformed UTF-8 is rejected');
assert.doesNotMatch(JSON.stringify(nativeImportInvalidUtf8.replies[0].response), /private:|uri|path/i, 'Harmony read errors do not include document identifiers');

let releaseOldPicker;
let importGeneration = 4;
let oldPickerInvocations = 0;
const staleNativeImport = createNativeHarness({ generation: () => importGeneration, selectFiles: () => {
  oldPickerInvocations += 1;
  return new Promise((resolve) => { releaseOldPicker = resolve; });
} });
staleNativeImport.proxy.callNative('eeeeeeeeeeeeeeee.14', 'importReplay', '', '');
await flushNativeMicrotasks(5);
const recoveredImportProxy = staleNativeImport.createProxy();
recoveredImportProxy.callNative('eeeeeeeeeeeeeeee.16', 'importReplay', '', '');
await flushNativeMicrotasks(5);
assert.equal(oldPickerInvocations, 1, 'a new proxy cannot open a second picker while the old system picker is unsettled');
assert.match(staleNativeImport.replies.find(({ id }) => id === 'eeeeeeeeeeeeeeee.16').response.error, /already active/);
importGeneration += 1;
releaseOldPicker([]);
await flushNativeMicrotasks(20);
assert.equal(staleNativeImport.replies.some(({ id }) => id === 'eeeeeeeeeeeeeeee.14'), false,
  'a picker callback owned by an obsolete Harmony page is ignored');
recoveredImportProxy.callNative('eeeeeeeeeeeeeeee.17', 'importReplay', '', '');
await flushNativeMicrotasks(10);
assert.equal(oldPickerInvocations, 2, 'the shared picker lease is released only after the old picker settles');
releaseOldPicker([]);
await flushNativeMicrotasks(20);

const native = createNativeHarness();
native.proxy.callNative('aaaaaaaaaaaaaaaa.1', 'shareReplay', '', validReplay);
await flushNativeMicrotasks();
assert.equal(native.stats().directoryExists, true, 'accessSync false triggers first-use directory creation');
assert.equal(native.replies[0].response.result?.status, 'opened', JSON.stringify(native.replies));
assert.equal(native.stats().writeCalls, 1);
assert.equal([...native.files.values()][0], validReplay, 'the shared file contains complete UTF-8 JSON');
  native.proxy.callNative('aaaaaaaaaaaaaaaa.2', 'shareReplay', '', validReplay);
  await flushNativeMicrotasks();
  assert.equal([...native.files.keys()].filter((path) => /replay-.*\.json$/.test(path)).length, 1, 'a second native request cannot rotate the active share file');
  assert.equal(native.replies[1].response.ok, false);
native.shareControllers[0].dismiss();
await flushNativeMicrotasks();
  assert.equal(native.replies[2].response.result.status, 'dismissed');
  assert.equal(native.files.size, 1, 'dismissal ends the active read window but retains the file in cache');

const shortWrite = createNativeHarness({ shortWrite: true });
shortWrite.proxy.callNative('bbbbbbbbbbbbbbbb.1', 'shareReplay', '', validReplay);
await flushNativeMicrotasks();
assert.equal(shortWrite.replies[0].response.ok, false, 'short file writes fail before Share Kit opens');
assert.equal(shortWrite.shareControllers.length, 0);
assert.equal(shortWrite.files.size, 0, 'partial file is removed after a short write');
assert.equal(shortWrite.descriptors.size, 0, 'file descriptor closes after a short write');

const oversizedPayload = JSON.stringify({ format: 'lifeline-replay', schemaVersion: 1, data: '💩'.repeat(1_000_000) });
const oversized = createNativeHarness();
oversized.proxy.callNative('cccccccccccccccc.1', 'shareReplay', '', oversizedPayload);
await flushNativeMicrotasks();
assert.equal(oversized.stats().accessCalls, 0, 'native UTF-8 size is checked before touching the cache');
assert.equal(oversized.stats().openCalls, 0);
assert.equal(oversized.replies[0].response.ok, false);

const rollbackTime = 1_700_000_000_000;
const clockRollback = createNativeHarness({ now: rollbackTime });
clockRollback.files.set(`/cache/lifeline-replay-share/replay-${rollbackTime + 86_400_000}-dddddddddddddddd-1.json`, validReplay);
clockRollback.proxy.callNative('eeeeeeeeeeeeeeee.1', 'shareReplay', '', validReplay);
await flushNativeMicrotasks();
assert.equal(cachedReplayCount(clockRollback.files), 2, 'future-stamped files survive a system clock rollback');

const expiry = createNativeHarness();
expiry.files.set(`/cache/lifeline-replay-share/replay-${1_800_000_000_000 - 15 * 86_400_000}-1111111111111111-1.json`, validReplay);
expiry.files.set(`/cache/lifeline-replay-share/replay-${1_800_000_000_000 - 86_400_000}-2222222222222222-1.json`, validReplay);
expiry.proxy.callNative('abababababababab.1', 'shareReplay', '', validReplay);
await flushNativeMicrotasks();
assert.equal(cachedReplayCount(expiry.files), 2, 'files older than 24 hours expire while recent files remain reusable');
assert.equal([...expiry.files.keys()].some((path) => path.includes('1111111111111111')), false);
assert.equal([...expiry.files.keys()].some((path) => path.includes('2222222222222222')), true);

const fullCache = createNativeHarness();
for (let index = 1; index <= 8; index += 1) {
  const created = 1_800_000_000_000 - (9 - index) * 1000;
  fullCache.files.set(`/cache/lifeline-replay-share/replay-${created}-ffffffffffffffff-${index}.json`, validReplay);
}
fullCache.proxy.callNative('1111111111111111.1', 'shareReplay', '', validReplay);
await flushNativeMicrotasks();
assert.equal(fullCache.replies[0].response.result.status, 'opened', 'the expanded bounded cache admits another ordinary share');
assert.equal(cachedReplayCount(fullCache.files), 9, 'ordinary ninth share succeeds without early eviction');
assert.equal([...fullCache.files.keys()].some((path) => path.includes('ffffffffffffffff-1.json')), true,
  'files younger than the minimum retention remain intact under ordinary share volume');

const saturatedCache = createNativeHarness();
for (let index = 1; index <= 32; index += 1) {
  const created = 1_800_000_000_000 - (33 - index) * 1000;
  saturatedCache.files.set(`/cache/lifeline-replay-share/replay-${created}-eeeeeeeeeeeeeeee-${index}.json`, validReplay);
}
saturatedCache.proxy.callNative('1515151515151515.1', 'shareReplay', '', validReplay);
await flushNativeMicrotasks();
assert.equal(saturatedCache.replies[0].response.ok, false, 'a full protected cache returns a visible error');
assert.match(saturatedCache.replies[0].response.error, /缓存暂满/);
assert.equal(cachedReplayCount(saturatedCache.files), 32, 'full cache failure does not evict a file before its one-hour minimum retention');

let finishLateShow;
let showInvocations = 0;
const slowShow = createNativeHarness({ show: () => {
  showInvocations += 1;
  return showInvocations === 1 ? new Promise((resolve) => { finishLateShow = resolve; }) : Promise.resolve();
} });
slowShow.proxy.callNative('1212121212121212.1', 'shareReplay', '', validReplay);
slowShow.proxy.callNative('1313131313131313.1', 'loadRecord', 'lifeline-local-game-session-v1', '');
await flushNativeMicrotasks();
assert.equal(slowShow.replies.some(({ id, response }) => id === '1313131313131313.1' && response.ok), true,
  'pending share panel handshake does not hold the serialized storage queue');
const nativeOpenTimerId = [...slowShow.timers.keys()][0];
assert.equal(slowShow.timers.get(nativeOpenTimerId).delay, 30_000);
slowShow.timers.get(nativeOpenTimerId).callback();
slowShow.timers.delete(nativeOpenTimerId);
await flushNativeMicrotasks();
assert.equal(slowShow.replies.find(({ id }) => id === '1212121212121212.1').response.ok, false,
  'open timeout reports a handshake failure while retaining native exclusion');
assert.equal(slowShow.proxy.activeShareIds.size, 1);
const uncertainFile = [...slowShow.files.keys()][0];
const nativeUnknownTimerId = [...slowShow.timers.keys()].at(-1);
assert.equal(slowShow.timers.get(nativeUnknownTimerId).delay, 9 * 60 * 1000);
slowShow.timers.get(nativeUnknownTimerId).callback();
await flushNativeMicrotasks();
assert.equal(slowShow.proxy.activeShareIds.size, 1, 'native watchdog reports unknown but does not pretend the panel closed');
assert.equal(slowShow.proxy.activeShareFiles.has(uncertainFile), true, 'outcome-unknown source file remains pinned');
const recoveredShareProxy = slowShow.createProxy();
recoveredShareProxy.callNative('1414141414141414.1', 'shareReplay', '', validReplay);
await flushNativeMicrotasks();
assert.match(slowShow.replies.find(({ id }) => id === '1414141414141414.1').response.error, /完全退出应用后重试/);
assert.equal(showInvocations, 1, 'a new proxy cannot open a second share panel while the old system panel is unsettled');
finishLateShow();
await flushNativeMicrotasks();
assert.equal(slowShow.replies.find(({ id, response }) => id === '1212121212121212.1' && response.result?.status === 'opened') !== undefined, true,
  'a late open is still attributed to its original request and remains guarded until dismiss');
slowShow.shareControllers[0].dismiss();
await flushNativeMicrotasks();
assert.equal(slowShow.proxy.activeShareIds.size, 0, 'dismissal releases native exclusion after a late open');
slowShow.proxy.callNative('1616161616161616.1', 'shareReplay', '', validReplay);
await flushNativeMicrotasks();
assert.equal(slowShow.proxy.activeShareIds.size, 1, 'a confirmed dismissal allows retry');
slowShow.shareControllers[0].dismiss();
await flushNativeMicrotasks();
assert.equal(slowShow.proxy.activeShareIds.size, 1, 'a late duplicate dismiss from the old controller cannot release the new request');
slowShow.shareControllers[1].dismiss();
await flushNativeMicrotasks();
assert.equal(slowShow.proxy.activeShareIds.size, 0);
await writeTombstoneReceipt();
console.log('verify-harmony-native-bridge: PASS (JS lifecycle plus transpiled ArkTS proxy and API-shaped host persistence model; not SDK compilation or device durability evidence)');
