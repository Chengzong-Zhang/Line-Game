import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from '../node_modules/typescript/lib/typescript.js';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harmonyRoot = path.join(mobileRoot, 'harmony/entry/src/main/ets/bridge');
const monitorSource = await readFile(path.join(harmonyRoot, 'NetworkStatusMonitor.ets'), 'utf8');
const proxySource = await readFile(path.join(harmonyRoot, 'LifelineNativeProxy.ets'), 'utf8');
const registrySource = await readFile(path.join(harmonyRoot, 'WebControllerRegistry.ets'), 'utf8');
const transpile = (source) => ts.transpileModule(source.replace(/^import .*;\r?\n/gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const drain = async () => { for (let index = 0; index < 140; index += 1) await Promise.resolve(); };
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const nonce = 'aaaaaaaaaaaaaaaa';
const token = `${nonce}.1`;
const tokenFor = (index) => `${nonce}.${index}`;

function monitorHarness(options = {}) {
  const objects = [];
  const seen = [];
  const live = new Set();
  const timers = new Map();
  let timerId = 0;
  let maxLive = 0;
  const counts = { create: 0, register: 0, unregister: 0, has: 0, defaults: 0, capabilities: 0 };
  const harness = {
    objects, seen, live, counts,
    get maxLive() { return maxLive; },
    async fireTimers() { for (const [id, callback] of [...timers]) if (timers.delete(id)) callback(); await drain(); },
    async emit(index, event, value) { objects[index].events.get(event)?.(value); await drain(); },
  };
  const connection = {
    NetCap: { NET_CAPABILITY_VALIDATED: 16 },
    createNetConnection() {
      counts.create += 1;
      const object = {
        events: new Map(),
        on(name, callback) { object.events.set(name, callback); },
        register(callback) {
          counts.register += 1;
          object.succeed = () => { live.add(object); maxLive = Math.max(maxLive, live.size); callback(null); };
          if (options.register) options.register(harness, object, callback);
          else Promise.resolve().then(object.succeed);
        },
        unregister(callback) {
          counts.unregister += 1;
          object.succeedUnregister = () => { live.delete(object); callback(null); };
          if (options.unregister) options.unregister(harness, object, callback);
          else Promise.resolve().then(object.succeedUnregister);
        },
      };
      objects.push(object);
      return object;
    },
    hasDefaultNet() { counts.has += 1; return Promise.resolve(true); },
    getDefaultNet() { counts.defaults += 1; return Promise.resolve({ netId: 1 }); },
    getNetCapabilities() { counts.capabilities += 1; return Promise.resolve({ networkCap: [16] }); },
  };
  const exports = {};
  new Function('exports', 'connection', 'setTimeout', 'clearTimeout', transpile(monitorSource))(
    exports, connection,
    (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
    (id) => timers.delete(id),
  );
  harness.monitor = exports.NetworkStatusMonitor;
  harness.start = (id = token) => harness.monitor.start(nonce, id, (status, page, subscription) => seen.push({ status, page, subscription }), () => true);
  harness.stop = (id = token) => harness.monitor.stop(nonce, id);
  return harness;
}

function hostHarness(options = {}) {
  const monitor = monitorHarness(options);
  const replies = [];
  const events = [];
  let currentUrl = 'https://lifeline.appassets.invalid/index.html';
  const registryExports = {};
  const cryptoFramework = { createRandom() { return { generateRandomSync(length) { return { data: randomBytes(length) }; } }; } };
  new Function('exports', 'url', 'cryptoFramework', transpile(registrySource))(registryExports, { URL }, cryptoFramework);
  const registry = registryExports.WebControllerRegistry;
  const jsContext = {
    __lifelineNativeComplete: (request, response) => replies.push({ request, response: JSON.parse(response) }),
    __lifelineNetworkStatusEvent: (raw) => events.push(JSON.parse(raw)),
  };
  const controller = {
    getUrl: () => currentUrl,
    getLastJavascriptProxyCallingFrameUrl: () => currentUrl,
    async runJavaScript(script) { vm.runInNewContext(script, { globalThis: jsContext }); return ''; },
  };
  registry.attach(controller);
  registry.markReady(controller);
  const proxyExports = {};
  new Function('exports', 'url', 'bundleManager', 'NetworkStatusMonitor', 'WebControllerRegistry', 'console', transpile(proxySource))(
    proxyExports, { URL }, { getBundleInfoForSelf: async () => ({ versionName: '1', versionCode: 1 }), BundleFlag: { GET_BUNDLE_INFO_DEFAULT: 0 } },
    monitor.monitor, registry, { warn() {}, error() {} },
  );
  const proxy = new proxyExports.LifelineNativeProxy({}, controller, {}, () => registry.currentGeneration(controller));
  return { ...monitor, proxy, registry, controller, replies, events, setUrl(value) { currentUrl = value; } };
}

const checks = [];
async function check(name, body) {
  try { await body(); checks.push({ name, status: 'PASS' }); }
  catch (error) { checks.push({ name, status: 'FAIL', error: String(error?.stack ?? error) }); }
}

await check('concurrent starts never keep multiple native observers alive', async () => {
  const h = monitorHarness();
  const outcomes = await Promise.allSettled([h.start(tokenFor(1)), h.start(tokenFor(2))]);
  assert.ok(outcomes.some((result) => result.status === 'fulfilled'));
  assert.ok(h.maxLive <= 1);
  await h.monitor.stop();
});

await check('late registration is unregistered before a replacement can start', async () => {
  const h = monitorHarness({ register: () => {} });
  const first = h.start(tokenFor(1));
  await drain();
  const stopping = h.stop(tokenFor(1));
  await drain();
  const replacement = h.start(tokenFor(2));
  await drain();
  assert.equal(h.counts.create, 1);
  h.objects[0].succeed();
  await Promise.all([first, stopping]);
  await drain();
  assert.equal(h.live.has(h.objects[0]), false);
  assert.equal(h.counts.create, 2);
  h.objects[1].succeed();
  await replacement;
  assert.ok(h.maxLive <= 1);
  await h.monitor.stop();
});

await check('stop invalidates callbacks synchronously before unregister completes', async () => {
  const h = monitorHarness({ unregister: () => {} });
  await h.start();
  const stopping = h.stop().catch(() => {});
  await drain();
  const before = h.seen.length;
  await h.emit(0, 'netAvailable', { netId: 7 });
  assert.equal(h.seen.length, before);
  await h.fireTimers();
  await stopping;
});

await check('failed unregister preserves ownership and blocks a second registration', async () => {
  const h = monitorHarness({ unregister: (_h, _object, callback) => Promise.resolve().then(() => callback({ code: 1 })) });
  await h.start();
  await assert.rejects(h.stop());
  await assert.rejects(h.start(tokenFor(2)));
  assert.equal(h.counts.create, 1);
  assert.equal(h.live.size, 1);
});

await check('an old owner stop cannot unregister its replacement', async () => {
  const h = monitorHarness();
  await h.start(tokenFor(1));
  await h.stop(tokenFor(1));
  await h.start(tokenFor(2));
  await h.stop(tokenFor(1));
  assert.equal(h.live.size, 1);
  await h.monitor.stop();
});

await check('background invalidates events and refuses a later start', async () => {
  const h = monitorHarness();
  await h.start();
  h.monitor.setForeground(false);
  const before = h.seen.length;
  await h.emit(0, 'netAvailable', { netId: 4 });
  assert.equal(h.seen.length, before);
  await assert.rejects(h.start(tokenFor(2)));
  await h.fireTimers();
});

await check('actual proxy rejects stale pages and emits only for its active page generation', async () => {
  const h = hostHarness();
  h.proxy.callNative(token, 'startNetworkStatus', '', token);
  await drain();
  assert.equal(h.replies.find((item) => item.request === token)?.response.ok, true);
  h.objects[0].events.get('netAvailable')({ netId: 3 });
  await drain();
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].subscriptionId, token);
  h.registry.markLoading(h.controller);
  h.objects[0].events.get('netCapabilitiesChange')({ netHandle: { netId: 3 }, netCap: { networkCap: [16] } });
  await drain();
  assert.equal(h.events.length, 1);
  await h.monitor.stop();
});

await check('background while a replacement waits for cleanup prevents registration', async () => {
  const h = hostHarness({ unregister: () => {} });
  h.proxy.callNative(tokenFor(1), 'startNetworkStatus', '', tokenFor(1));
  await drain();
  h.proxy.callNative(tokenFor(2), 'startNetworkStatus', '', tokenFor(2));
  await drain();
  h.monitor.setForeground(false);
  await drain();
  h.objects[0].succeedUnregister();
  await drain();
  assert.equal(h.objects.length, 1);
  assert.equal(h.replies.find((item) => item.request === tokenFor(2))?.response.ok, false);
  await h.fireTimers();
});

await check('background query returns unknown without reading native network state', async () => {
  const h = hostHarness();
  h.monitor.setForeground(false);
  await drain();
  h.proxy.callNative(token, 'getNetworkStatus', '', '');
  await drain();
  assert.equal(h.counts.has, 0);
  assert.equal(h.replies[0]?.response.result.availability, 'unknown');
});

assert.ok(checks.length >= 9);
console.log(JSON.stringify({ status: checks.some((item) => item.status === 'FAIL') ? 'FAIL' : 'PASS', checks }));
if (checks.some((item) => item.status === 'FAIL')) process.exitCode = 1;
