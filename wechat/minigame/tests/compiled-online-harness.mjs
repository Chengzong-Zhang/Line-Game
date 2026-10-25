import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

// This harness executes the candidate bytes, never imports a source SUT and
// never exposes createApp, the application instance, or the VM context.
// Canvas text/arcs are observations, not a browser/device rendering claim.
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = value => value === undefined ? undefined : structuredClone(value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const errorMessage = error => String(error?.message || error);
const now = () => Date.now();
const FORBIDDEN_GLOBALS = ['URL', 'URLSearchParams', 'fetch', 'WebSocket', 'document', 'window',
  'crypto', 'TextEncoder', 'TextDecoder', 'process', 'require', 'Buffer'];
const HTTP_ROUTES = [
  ['GET', /^\/api\/wechat\/(?:status|account)$/],
  ['POST', /^\/api\/wechat\/(?:login|account\/(?:link|unlink|delete|profile)|rooms|rooms\/join)$/],
  ['GET', /^\/api\/wechat\/rooms\/[A-Z2-9]{8}$/],
  ['POST', /^\/api\/wechat\/rooms\/[A-Z2-9]{8}\/(?:ready|leave|rematch|actions)$/],
];

function checkedLoopback(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:', 'The fixture must use an HTTP loopback origin');
  assert.ok(url.hostname === '127.0.0.1' || url.hostname === '[::1]',
    'Use a literal loopback address, not a DNS name or an external address');
  assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
    'The loopback destination must be an origin without credentials, path or query');
  return url.origin;
}

async function readCandidate(candidateDir) {
  const root = path.resolve(candidateDir);
  const candidate = JSON.parse(await fs.readFile(path.join(root, 'candidate.json'), 'utf8'));
  const dist = path.join(root, 'project', 'dist');
  const manifestBytes = await fs.readFile(path.join(dist, 'build-manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(candidate.profile, 'online', 'An explicit online candidate is required');
  assert.equal(candidate.config?.onlineEnabled, true);
  const service = new URL(candidate.config.apiBase);
  assert.equal(service.protocol, 'https:');
  assert.equal(candidate.config.apiBase, service.origin, 'Candidate apiBase must be a plain HTTPS origin');
  assert.ok(!service.username && !service.password);
  for (const key of ['apiBase', 'onlineEnabled', 'workerTimeoutMs']) {
    assert.equal(candidate.config[key], manifest.config?.[key], `Candidate and build configuration differ: ${key}`);
  }
  const mainBytes = await fs.readFile(path.join(dist, 'game.js'));
  const workerBytes = await fs.readFile(path.join(dist, 'workers', 'index.js'));
  const hashes = {
    main: sha256(mainBytes), worker: sha256(workerBytes), manifest: sha256(manifestBytes),
  };
  for (const [relative, bytes, digest] of [
    ['game.js', mainBytes, hashes.main], ['workers/index.js', workerBytes, hashes.worker],
  ]) {
    const output = manifest.outputs?.find(item => item.path === relative);
    const frozen = candidate.files?.find(item => item.path === `dist/${relative}`);
    assert.equal(output?.sha256, digest, `Build manifest hash mismatch: ${relative}`);
    assert.equal(output?.bytes, bytes.length, `Build manifest size mismatch: ${relative}`);
    assert.equal(frozen?.sha256, digest, `Candidate hash mismatch: ${relative}`);
    assert.equal(frozen?.bytes, bytes.length, `Candidate size mismatch: ${relative}`);
  }
  assert.equal(candidate.files?.find(item => item.path === 'dist/build-manifest.json')?.sha256,
    hashes.manifest, 'Candidate build-manifest hash mismatch');
  return {
    root, dist, candidate, config: copy(candidate.config), hashes,
    mainSource: mainBytes.toString('utf8'), workerSource: workerBytes.toString('utf8'),
  };
}

// Build a message copier in the recipient realm. Records are intentionally
// re-keyed, and arrays/buffers have the recipient's prototypes and ownership.
function realmCopier(context) {
  return vm.runInContext(`(function clone(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
      const output = new Uint8Array(value.byteLength); output.set(new Uint8Array(value)); return output.buffer;
    }
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const buffer = new Uint8Array(bytes).buffer;
      const name = Object.prototype.toString.call(value).slice(8, -1);
      const types = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
        Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView };
      if (!types[name]) throw new Error('Unsupported bridge view');
      return new types[name](buffer);
    }
    if (Array.isArray(value)) return value.map(clone);
    const output = {};
    for (const key of Object.keys(value).sort()) Object.defineProperty(output, key,
      { value: clone(value[key]), writable: true, enumerable: true, configurable: true });
    return output;
  })`, context);
}

/**
 * Run an immutable online candidate using wx mocks and a loopback-only bridge.
 * Modal/action-sheet controls keep prompts pending until queued/responded.
 * login defaults to the fixture identity "blue"; pass loginCode: "red" for its peer.
 *
 * trace.requests: { id,url,method,data,header,mappedUrl,startedAt,settled,
 *                   statusCode?,responseData?,error?,endedAt? }
 * trace.workerMessages: { workerId,direction,id,kind,context,payload?,ok?,result?,
 *                         error?,message,at }
 * trace.sockets: { id,url,mappedUrl,readyState,closed,events,sent,received }
 * Socket events retain original data text, plus close code/reason.
 */
export async function createCompiledOnlineHarness({
  candidateDir, loopbackOrigin, loginCode = 'blue', language = 'zh',
  storage = new Map(), width = 390, height = 844, pixelRatio = 3,
  launchOptions = {}, frameDelayMs = 0, callbackTimeoutMs = 2000,
} = {}) {
  assert.ok(candidateDir, 'candidateDir is required');
  const destination = checkedLoopback(loopbackOrigin);
  const source = await readCandidate(candidateDir);
  assert.ok(storage instanceof Map, 'storage must be a Map');
  assert.ok(typeof globalThis.fetch === 'function' && typeof globalThis.WebSocket === 'function',
    'This harness requires host Node fetch and WebSocket implementations');
  assert.ok(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0);
  if (!storage.has('lifeline-wx-language')) storage.set('lifeline-wx-language', language);
  const trace = {
    logins: [], requests: [], sockets: [], workerMessages: [], workers: [], frames: [],
    modals: [], actionSheets: [], lifecycle: [], errors: [], blocked: [], storage: [],
    assets: [], shares: [], touches: [],
  };
  const listeners = new Map(), timers = new Map(), workerInstances = [], socketInstances = [];
  const pendingRequests = new Set(), controllers = new Set();
  let disposed = false, disposing = false, disposeResult, nextTimer = 0, mainContext, copyToMain;
  let currentTexts = [], currentArcs = [], pendingFrame = null, clipboard = '', shareProvider;
  let windowInfo = { windowWidth: width, windowHeight: height, pixelRatio,
    safeArea: { top: 48, bottom: height - 34 }, statusBarHeight: 48 };
  const recordError = (where, error) => {
    trace.errors.push({ where, message: errorMessage(error), stack: error?.stack || '', at: now() });
  };
  const invoke = (callback, args = [], where = 'wx callback') => {
    if (disposed || typeof callback !== 'function') return;
    try {
      const result = callback(...args);
      if (result && typeof result.then === 'function') result.catch(error => recordError(where, error));
      return result;
    } catch (error) { recordError(where, error); }
  };
  const setTracked = (fn, delay, repeat = false, args = [], owner = 'main') => {
    if (disposed) return 0;
    assert.equal(typeof fn, 'function', 'String timer handlers are not supported');
    const id = ++nextTimer;
    const callback = () => {
      if (!repeat) timers.delete(id);
      invoke(fn, args, `${owner} ${repeat ? 'interval' : 'timeout'}`);
    };
    const handle = repeat ? setInterval(callback, delay) : setTimeout(callback, delay);
    timers.set(id, { handle, repeat, owner });
    return id;
  };
  const clearTracked = id => {
    const timer = timers.get(id);
    if (!timer) return;
    (timer.repeat ? clearInterval : clearTimeout)(timer.handle);
    timers.delete(id);
  };
  const later = (fn, owner = 'wx') => setTracked(fn, 0, false, [], owner);
  const on = (event, callback) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(callback);
  };
  const off = (event, callback) => callback ? listeners.get(event)?.delete(callback) : listeners.delete(event);
  const emit = (event, value = {}) => {
    for (const callback of [...(listeners.get(event) || [])]) invoke(callback, [copyToMain(value)], event);
  };
  const finish = (options, result, ok = true) => {
    const payload = copyToMain(result);
    invoke(ok ? options.success : options.fail, [payload]);
    invoke(options.complete, [copyToMain(result)]);
  };
  const blocked = (kind, url, reason) => {
    trace.blocked.push({ kind, url: String(url), reason, at: now() });
    throw new Error(`HARNESS_TRANSPORT_BLOCKED: ${reason}`);
  };
  const mapTransport = (raw, kind, method = 'GET') => {
    let parsed;
    try { parsed = new URL(raw); } catch { return blocked(kind, raw, 'Invalid absolute URL'); }
    const expected = kind === 'socket' ? source.config.apiBase.replace(/^https:/, 'wss:') : source.config.apiBase;
    if (parsed.origin !== expected || parsed.username || parsed.password || parsed.search || parsed.hash
      || raw !== `${expected}${parsed.pathname}` || /[%\\]/.test(parsed.pathname)) {
      return blocked(kind, raw, 'Request does not match the frozen candidate origin and canonical path');
    }
    const allowed = kind === 'socket' ? parsed.pathname === '/api/wechat/ws'
      : HTTP_ROUTES.some(([verb, pattern]) => verb === method && pattern.test(parsed.pathname));
    if (!allowed) return blocked(kind, raw, `Route or method is outside the fixture allowlist (${method})`);
    return `${kind === 'socket' ? destination.replace(/^http:/, 'ws:') : destination}${parsed.pathname}`;
  };

  function nativeControl(kind, history, normalize, defaultResponse) {
    const waiting = [], queued = [];
    let auto = defaultResponse !== undefined;
    const answer = (entry, response) => {
      const index = waiting.indexOf(entry);
      if (index < 0 || entry.record.settled) throw new Error(`No pending ${kind} response`);
      waiting.splice(index, 1);
      let result;
      try {
        result = normalize(typeof response === 'function' ? response(copy(entry.record.options)) : response,
          entry.record.options);
      } catch (error) {
        recordError(`${kind} fixture response`, error);
        result = { ok: false, value: { errMsg: `${kind}:fail invalid fixture response` } };
      }
      entry.record.response = copy(result.value);
      entry.record.settled = true;
      entry.record.endedAt = now();
      return new Promise(resolve => later(() => {
        finish(entry.options, result.value, result.ok);
        // A second event-loop turn lets Promise continuations from the native
        // callback run before the scenario asserts denial had no side effects.
        later(() => {
          entry.record.delivered = true; entry.record.deliveredAt = now();
          resolve(copy(entry.record));
        });
      }));
    };
    const drain = () => {
      while (waiting.length && queued.length) answer(waiting[0], queued.shift());
    };
    return {
      request(options = {}) {
        const visibleOptions = {};
        for (const [key, value] of Object.entries(options)) if (typeof value !== 'function') visibleOptions[key] = copy(value);
        const record = { id: history.length + 1, options: visibleOptions, startedAt: now(), settled: false };
        history.push(record); waiting.push({ options, record });
        drain();
        if (auto && waiting.some(entry => entry.record === record)) {
          const entry = waiting.find(item => item.record === record);
          answer(entry, typeof defaultResponse === 'function' ? defaultResponse() : defaultResponse);
        }
      },
      get pending() { return waiting.map(entry => copy({ ...entry.record.options, ...entry.record })); },
      get auto() { return auto; },
      set auto(value) { auto = Boolean(value); },
      queue(...responses) { queued.push(...responses); drain(); },
      respond(response, index = 0) {
        const entry = waiting[index];
        if (!entry) throw new Error(`No pending ${kind} at index ${index}`);
        return answer(entry, response);
      },
    };
  }
  const modal = nativeControl('showModal', trace.modals, response => {
    if (response instanceof Error) return { ok: false, value: { errMsg: `showModal:fail ${response.message}` } };
    const result = typeof response === 'string' ? { confirm: true, content: response }
      : typeof response === 'boolean' ? { confirm: response } : response || { confirm: false };
    return { ok: true, value: { errMsg: 'showModal:ok', ...result, confirm: Boolean(result.confirm), cancel: !result.confirm } };
  });
  const actionSheet = nativeControl('showActionSheet', trace.actionSheets, (response, options) => {
    if (response === null || response === false || response?.cancel === true || response instanceof Error) {
      return { ok: false, value: { errMsg: 'showActionSheet:fail cancel' } };
    }
    const tapIndex = typeof response === 'string' ? options.itemList.indexOf(response)
      : typeof response === 'number' ? response : response?.tapIndex;
    assert.ok(Number.isInteger(tapIndex) && tapIndex >= 0 && tapIndex < options.itemList.length,
      'Action-sheet response must identify an existing item');
    return { ok: true, value: { errMsg: 'showActionSheet:ok', tapIndex } };
  });
  const login = nativeControl('login', trace.logins, response => {
    if (response === false || response === null || response instanceof Error) {
      return { ok: false, value: { errMsg: 'login:fail fixture rejection' } };
    }
    const result = typeof response === 'string' ? { code: response } : response;
    assert.ok(typeof result?.code === 'string' && result.code, 'A fixture login code is required');
    return { ok: true, value: { errMsg: 'login:ok', ...result } };
  }, () => loginCode);

  function request(options = {}) {
    const record = {
      id: trace.requests.length + 1, url: options.url, method: String(options.method || 'GET').toUpperCase(),
      data: copy(options.data), header: copy(options.header || {}), startedAt: now(), settled: false,
    };
    trace.requests.push(record);
    const controller = new AbortController();
    controllers.add(controller);
    let deadline, abortReason = null;
    const task = {
      abort() { abortReason = 'abort'; controller.abort(); },
      onHeadersReceived(callback) { on(`request-${record.id}-headers`, callback); },
      offHeadersReceived(callback) { off(`request-${record.id}-headers`, callback); },
    };
    const operation = (async () => {
      try {
        record.mappedUrl = mapTransport(options.url, 'request', record.method);
        assert.ok(options.responseType === undefined || options.responseType === 'text',
          'Only JSON/text fixture responses are supported');
        const headers = { ...record.header };
        const body = options.data === undefined ? undefined
          : typeof options.data === 'string' ? options.data : JSON.stringify(options.data);
        if (body !== undefined && !Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json';
        }
        deadline = setTracked(() => { abortReason = 'timeout'; controller.abort(); },
          Number.isFinite(options.timeout) ? options.timeout : 10000, false, [], 'request');
        const response = await globalThis.fetch(record.mappedUrl, {
          method: record.method, headers, body, signal: controller.signal, redirect: 'error',
        });
        const header = Object.fromEntries(response.headers);
        emit(`request-${record.id}-headers`, { header });
        const text = await response.text();
        let data = text;
        if (options.dataType !== 'text') { try { data = JSON.parse(text); } catch { /* wx returns text if not JSON. */ } }
        record.statusCode = response.status; record.responseData = copy(data);
        record.settled = true; record.endedAt = now();
        finish(options, { data, statusCode: response.status, header, errMsg: 'request:ok' });
      } catch (error) {
        record.error = abortReason || errorMessage(error);
        record.settled = true; record.endedAt = now();
        finish(options, { errMsg: `request:fail ${record.error}` }, false);
      } finally {
        clearTracked(deadline); controllers.delete(controller);
        listeners.delete(`request-${record.id}-headers`);
      }
    })();
    pendingRequests.add(operation);
    operation.finally(() => pendingRequests.delete(operation));
    return task;
  }

  function connectSocket(options = {}) {
    const record = { id: trace.sockets.length + 1, url: options.url, readyState: 0, closed: false,
      events: [], sent: [], received: [], startedAt: now() };
    trace.sockets.push(record);
    const handlers = { open: new Set(), message: new Set(), error: new Set(), close: new Set() };
    let native, closeRequested = false, resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    const signal = (type, data) => {
      record.events.push({ type, ...copy(data), at: now() });
      for (const callback of [...handlers[type]]) invoke(callback, [copyToMain(data)], `socket ${type}`);
    };
    const closeEvent = data => {
      if (record.closed) return;
      record.closed = true; record.readyState = 3; record.endedAt = now();
      signal('close', data); resolveClosed();
    };
    const task = {
      get readyState() { return record.readyState; },
      onOpen: callback => handlers.open.add(callback), offOpen: callback => callback ? handlers.open.delete(callback) : handlers.open.clear(),
      onMessage: callback => handlers.message.add(callback), offMessage: callback => callback ? handlers.message.delete(callback) : handlers.message.clear(),
      onError: callback => handlers.error.add(callback), offError: callback => callback ? handlers.error.delete(callback) : handlers.error.clear(),
      onClose: callback => handlers.close.add(callback), offClose: callback => callback ? handlers.close.delete(callback) : handlers.close.clear(),
      send(sendOptions = {}) {
        const data = copy(sendOptions.data);
        if (!native || native.readyState !== 1 || closeRequested || disposed) {
          later(() => finish(sendOptions, { errMsg: 'sendSocketMessage:fail socket is not open' }, false));
          return;
        }
        try {
          native.send(data);
          record.sent.push(data); record.events.push({ type: 'send', data, at: now() });
          later(() => finish(sendOptions, { errMsg: 'sendSocketMessage:ok' }));
        } catch (error) {
          later(() => finish(sendOptions, { errMsg: `sendSocketMessage:fail ${errorMessage(error)}` }, false));
        }
      },
      close(closeOptions = {}) {
        if (record.closed) {
          later(() => finish(closeOptions, { errMsg: 'closeSocket:ok' }));
          return;
        }
        try {
          closeRequested = true; record.readyState = 2;
          native?.close(closeOptions.code || 1000, closeOptions.reason || '');
          if (!native) closeEvent({ code: closeOptions.code || 1000, reason: closeOptions.reason || '' });
          later(() => finish(closeOptions, { errMsg: 'closeSocket:ok' }));
        } catch (error) {
          closeRequested = false;
          record.readyState = native?.readyState ?? 0;
          later(() => finish(closeOptions, { errMsg: `closeSocket:fail ${errorMessage(error)}` }, false));
        }
      },
    };
    socketInstances.push({ task, record, closed });
    later(() => {
      if (closeRequested) return;
      try {
        record.mappedUrl = mapTransport(options.url, 'socket');
        // Node's standards-based WebSocket handshake rejects redirects.
        native = new globalThis.WebSocket(record.mappedUrl, options.protocols || []);
        native.binaryType = 'arraybuffer';
        native.addEventListener('open', () => {
          record.readyState = 1; signal('open', { header: {}, statusCode: 101 });
        });
        native.addEventListener('message', event => {
          const data = copy(event.data);
          record.received.push(data); signal('message', { data });
        });
        native.addEventListener('error', event => signal('error', {
          errMsg: `SocketTask:fail ${errorMessage(event.error || event.message || 'WebSocket error')}`,
        }));
        native.addEventListener('close', event => closeEvent({ code: event.code, reason: event.reason, wasClean: event.wasClean }));
        finish(options, { errMsg: 'connectSocket:ok' });
      } catch (error) {
        const errMsg = `connectSocket:fail ${errorMessage(error)}`;
        finish(options, { errMsg }, false); signal('error', { errMsg });
        closeEvent({ code: 1006, reason: 'Connection rejected' });
      }
    });
    return task;
  }

  const contextState = { font: '16px sans-serif', textAlign: 'left', textBaseline: 'alphabetic', fillStyle: '#000' };
  const stateStack = [];
  const canvasContext = new Proxy({
    ...contextState,
    measureText(text) { return { width: String(text).length * (parseFloat(this.font.match(/[\d.]+px/)?.[0]) || 16) * 0.5 }; },
    fillText(text, x, y) {
      const item = { text: String(text), x, y, font: this.font, align: this.textAlign,
        baseline: this.textBaseline, color: this.fillStyle };
      (pendingFrame?.texts || currentTexts).push(item);
    },
    arc(x, y, radius) { (pendingFrame?.arcs || currentArcs).push({ x, y, radius }); },
    save() {
      stateStack.push(Object.fromEntries(Object.keys(contextState).map(key => [key, this[key]])));
    },
    restore() { Object.assign(this, stateStack.pop() || contextState); },
  }, { get: (target, key) => key in target ? target[key] : () => {} });
  const canvas = { width: 0, height: 0, getContext: kind => {
    assert.equal(kind, '2d'); return canvasContext;
  } };
  const assetPath = relative => {
    if (typeof relative !== 'string' || relative.includes('\\') || relative.startsWith('/')
      || !/^(?:guide|models)\/[a-zA-Z0-9_./-]+$/.test(relative) || relative.split('/').includes('..')) {
      throw new Error('HARNESS_ASSET_PATH_REJECTED');
    }
    const expected = source.candidate.files.find(item => item.path === `dist/${relative}`);
    if (!expected) throw new Error('HARNESS_ASSET_NOT_IN_CANDIDATE');
    return { filename: path.join(source.dist, relative), expected };
  };
  async function readAsset(relative) {
    const { filename, expected } = assetPath(relative);
    const bytes = await fs.readFile(filename);
    assert.equal(sha256(bytes), expected.sha256, `Candidate asset changed: ${relative}`);
    trace.assets.push({ path: relative, bytes: bytes.length, sha256: expected.sha256 });
    return bytes;
  }
  const wx = {
    createCanvas: () => canvas,
    createImage() {
      let imageSource = '';
      const image = { width: 0, height: 0, complete: false, onload: null, onerror: null,
        get src() { return imageSource; },
        set src(relative) {
          imageSource = relative;
          readAsset(relative).then(bytes => {
            if (disposed) return;
            assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Only bundled PNG guide assets are supported');
            image.width = bytes.readUInt32BE(16); image.height = bytes.readUInt32BE(20); image.complete = true;
            invoke(image.onload);
          }).catch(error => { if (!disposed) invoke(image.onerror, [copyToMain({ errMsg: errorMessage(error) })]); });
        },
      };
      return image;
    },
    getWindowInfo: () => copyToMain(windowInfo),
    getSystemInfoSync: () => copyToMain(windowInfo),
    getMenuButtonBoundingClientRect: () => copyToMain({ top: 48, bottom: 88, left: width - 108, right: width - 16, width: 92, height: 40 }),
    getStorageSync(key) { trace.storage.push({ operation: 'get', key, at: now() }); return copyToMain(storage.get(key)); },
    setStorageSync(key, value) { storage.set(key, copy(value)); trace.storage.push({ operation: 'set', key, at: now() }); },
    removeStorageSync(key) { storage.delete(key); trace.storage.push({ operation: 'remove', key, at: now() }); },
    getClipboardData: options => later(() => finish(options, { data: clipboard, errMsg: 'getClipboardData:ok' })),
    setClipboardData: options => {
      clipboard = String(options.data);
      later(() => finish(options, { errMsg: 'setClipboardData:ok' }));
    },
    onTouchStart: callback => on('touchstart', callback), offTouchStart: callback => off('touchstart', callback),
    onTouchEnd: callback => on('touchend', callback), offTouchEnd: callback => off('touchend', callback),
    onTouchMove: callback => on('touchmove', callback), offTouchMove: callback => off('touchmove', callback),
    onTouchCancel: callback => on('touchcancel', callback), offTouchCancel: callback => off('touchcancel', callback),
    onHide: callback => on('hide', callback), offHide: callback => off('hide', callback),
    onShow: callback => on('show', callback), offShow: callback => off('show', callback),
    onWindowResize: callback => on('resize', callback), offWindowResize: callback => off('resize', callback),
    showShareMenu() {},
    onShareAppMessage: callback => { shareProvider = callback; },
    shareAppMessage: payload => trace.shares.push({ ...copy(payload), at: now() }),
    getLaunchOptionsSync: () => copyToMain(launchOptions),
    showModal: options => modal.request(options),
    showActionSheet: options => actionSheet.request(options),
    login: options => login.request(options),
    request, connectSocket,
    loadSubpackage(options) {
      const subpackage = source.candidate.subpackages?.find(item => item.name === options.name);
      later(() => finish(options, { errMsg: subpackage ? 'loadSubpackage:ok' : 'loadSubpackage:fail unknown candidate package' }, Boolean(subpackage)));
      return { onProgressUpdate: callback => later(() => invoke(callback, [copyToMain({ progress: 100 })])) };
    },
    getFileSystemManager: () => ({ readFile(options) {
      readAsset(options.filePath).then(bytes => {
        const data = options.encoding ? bytes.toString(options.encoding) : Uint8Array.from(bytes).buffer;
        finish(options, { data, errMsg: 'readFile:ok' });
      }).catch(error => finish(options, { errMsg: `readFile:fail ${errorMessage(error)}` }, false));
    } }),
    createWorker(filename) {
      assert.equal(filename, 'workers/index.js', 'Only the candidate Worker entry is permitted');
      let receiveMain, receiveWorker, onError, onKilled;
      const record = { id: trace.workers.length + 1, filename, sha256: source.hashes.worker, terminated: false, startedAt: now() };
      trace.workers.push(record);
      const requestKinds = new Map();
      const recordMessage = (direction, message) => {
        const snapshot = copy(message);
        const entry = { workerId: record.id, direction, id: snapshot.id,
          kind: snapshot.kind || requestKinds.get(snapshot.id), context: copy(snapshot.context),
          message: snapshot, at: now(), frameIdAtEmission: trace.frames.at(-1)?.id || 0 };
        for (const key of ['payload', 'ok', 'result', 'error']) if (key in snapshot) entry[key] = copy(snapshot[key]);
        trace.workerMessages.push(entry);
        return snapshot;
      };
      let copyToWorker;
      const instance = {
        onMessage: callback => { receiveMain = callback; },
        onError: callback => { onError = callback; },
        onProcessKilled: callback => { onKilled = callback; },
        postMessage(message) {
          if (record.terminated) throw new Error('Worker has terminated');
          requestKinds.set(message.id, message.kind);
          const snapshot = recordMessage('main-to-worker', message);
          later(() => {
            if (record.terminated) return;
            try {
              const result = receiveWorker(copyToWorker(snapshot));
              if (result?.then) result.catch(error => {
                recordError('worker handler', error); invoke(onError, [copyToMain({ message: errorMessage(error) })]);
              });
            } catch (error) {
              recordError('worker handler', error); invoke(onError, [copyToMain({ message: errorMessage(error) })]);
            }
          }, `worker-${record.id}`);
        },
        terminate() {
          record.terminated = true; record.endedAt = now();
          for (const [id, timer] of timers) if (timer.owner === `worker-${record.id}`) clearTracked(id);
        },
      };
      const workerContext = vm.createContext({
        worker: {
          onMessage: callback => { receiveWorker = callback; },
          postMessage(message) {
            const snapshot = recordMessage('worker-to-main', message);
            const entry = trace.workerMessages.at(-1);
            later(() => {
              if (record.terminated) return;
              invoke(receiveMain, [copyToMain(snapshot)], 'worker message');
              entry.delivered = true; entry.deliveredAt = now();
            }, `worker-${record.id}`);
          },
        },
      });
      copyToWorker = realmCopier(workerContext);
      for (const name of [...FORBIDDEN_GLOBALS, 'wx']) {
        assert.equal(vm.runInContext(`typeof ${name}`, workerContext), 'undefined', `Worker global leaked: ${name}`);
      }
      vm.runInContext(source.workerSource, workerContext, { timeout: callbackTimeoutMs, filename: path.join(source.dist, filename) });
      assert.equal(typeof receiveWorker, 'function', 'The original Worker did not register a message handler');
      workerInstances.push(instance);
      return instance;
    },
  };
  mainContext = vm.createContext({
    wx,
    setTimeout: (fn, delay = 0, ...args) => setTracked(fn, delay, false, args),
    clearTimeout: clearTracked,
    setInterval: (fn, delay = 0, ...args) => setTracked(fn, delay, true, args),
    clearInterval: clearTracked,
    requestAnimationFrame: callback => setTracked(() => {
      const frame = { id: trace.frames.length + 1, at: now(), texts: [], arcs: [] };
      pendingFrame = frame;
      try { callback(now()); }
      finally {
        pendingFrame = null; currentTexts = frame.texts; currentArcs = frame.arcs;
        frame.width = canvas.width; frame.height = canvas.height; trace.frames.push(frame);
      }
    }, frameDelayMs, false, [], 'frame'),
    cancelAnimationFrame: clearTracked,
  });
  copyToMain = realmCopier(mainContext);
  for (const name of FORBIDDEN_GLOBALS) {
    assert.equal(vm.runInContext(`typeof ${name}`, mainContext), 'undefined', `Main global leaked: ${name}`);
  }
  const matches = (matcher, item) => typeof matcher === 'function' ? matcher(item.text, item)
    : matcher instanceof RegExp ? (matcher.lastIndex = 0, matcher.test(item.text)) : item.text === matcher;
  const findText = (matcher, index = -1) => currentTexts.filter(item => matches(matcher, item)).at(index);
  async function waitFor(predicate, { timeoutMs = 10000, label = 'condition' } = {}) {
    const deadline = now() + timeoutMs;
    do {
      if (trace.errors.length) throw new Error(`Harness callback failed: ${JSON.stringify(trace.errors.at(-1))}`);
      if (trace.blocked.length) throw new Error(`Harness blocked transport: ${JSON.stringify(trace.blocked.at(-1))}`);
      const result = await predicate();
      if (result) return result;
      if (disposed) throw new Error(`Harness disposed while waiting for ${label}`);
      await sleep(5);
    } while (now() < deadline);
    throw new Error(`Timed out waiting for ${label}; drawn texts: ${JSON.stringify(currentTexts.map(item => item.text))}; pending modals: ${JSON.stringify(modal.pending)}; pending sheets: ${JSON.stringify(actionSheet.pending)}`);
  }
  const tap = ({ x, y }) => {
    assert.ok(!disposed && Number.isFinite(x) && Number.isFinite(y), 'Tap requires active, finite canvas coordinates');
    trace.touches.push({ x, y, frameId: trace.frames.at(-1)?.id, at: now() });
    const point = { identifier: 1, clientX: x, clientY: y, pageX: x, pageY: y };
    emit('touchstart', { touches: [point], changedTouches: [point], timeStamp: now() });
    emit('touchend', { touches: [], changedTouches: [point], timeStamp: now() });
  };
  const lifecycle = {
    hide() { trace.lifecycle.push({ type: 'hide', at: now() }); emit('hide'); },
    show(options = launchOptions) { trace.lifecycle.push({ type: 'show', at: now() }); emit('show', options); },
    resize(next) {
      windowInfo = { ...windowInfo, ...copy(next) };
      trace.lifecycle.push({ type: 'resize', options: copy(next), at: now() });
      emit('resize', { size: { windowWidth: windowInfo.windowWidth, windowHeight: windowInfo.windowHeight } });
    },
  };
  async function dispose() {
    if (disposeResult) return disposeResult;
    if (disposing) {
      while (!disposeResult) await sleep(5);
      return disposeResult;
    }
    disposing = true;
    const before = {
      timers: timers.size, workers: trace.workers.filter(item => !item.terminated).length,
      sockets: trace.sockets.filter(item => !item.closed).length, requests: pendingRequests.size,
    };
    lifecycle.hide();
    for (const instance of workerInstances) instance.terminate();
    for (const controller of controllers) controller.abort();
    for (const instance of socketInstances) instance.task.close({ code: 1000, reason: 'Harness disposed' });
    disposed = true;
    for (const id of [...timers.keys()]) clearTracked(id);
    const complete = Promise.allSettled([...pendingRequests, ...socketInstances.map(item => item.closed)]);
    let timeout;
    await Promise.race([complete, new Promise(resolve => { timeout = setTimeout(resolve, 3000); })]);
    clearTimeout(timeout);
    disposeResult = {
      before,
      terminatedWorkers: trace.workers.filter(item => item.terminated).length,
      closedSockets: trace.sockets.filter(item => item.closed).length,
      settledRequests: trace.requests.filter(item => item.settled).length,
      remaining: {
        timers: timers.size, workers: trace.workers.filter(item => !item.terminated).length,
        sockets: trace.sockets.filter(item => !item.closed).length, requests: pendingRequests.size,
      },
    };
    return copy(disposeResult);
  }
  try {
    vm.runInContext(source.mainSource, mainContext, { timeout: callbackTimeoutMs, filename: path.join(source.dist, 'game.js') });
  } catch (error) { await dispose(); throw error; }
  return {
    candidateId: source.candidate.candidateId, config: copy(source.config), hashes: { ...source.hashes },
    trace, storage, modal, actionSheet, login, lifecycle, tap, waitFor, dispose,
    get texts() { return copy(currentTexts); },
    get arcs() { return copy(currentArcs); },
    get frames() { return copy(trace.frames); },
    get clipboard() { return clipboard; },
    set clipboard(value) { clipboard = String(value); },
    get sharePayload() { return shareProvider ? copy(invoke(shareProvider)) : null; },
    tapText(matcher, { index = -1 } = {}) {
      const item = findText(matcher, index);
      assert.ok(item, `Visible text not found: ${String(matcher)}`);
      tap(item); return copy(item);
    },
    async waitText(matcher, { index = -1, timeoutMs = 10000 } = {}) {
      return copy(await waitFor(() => findText(matcher, index), { timeoutMs, label: `text ${String(matcher)}` }));
    },
  };
}
