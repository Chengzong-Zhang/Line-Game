// Test host only. Runs unmodified dist/game.js through createWxPlatform(wx).
// Never included in the Mini Game build, and never reads real WeChat credentials.
const canvas = document.querySelector('#game'), status = document.querySelector('#status');
const params = new URLSearchParams(location.search);
const dimension = (key, fallback, min, max) => {
  const value = Number(params.get(key));
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};
const width = dimension('width', 390, 320, 768), height = dimension('height', 844, 568, 1366);
const top = 88, bottom = 24, storagePrefix = 'lifeline-offline-host-v1:';
canvas.style.width = `min(${width}px, 100vw, calc(92vh * ${width / height}))`;
canvas.style.height = 'auto'; canvas.style.aspectRatio = `${width} / ${height}`;
const events = {}, touches = new Map(), workers = new Set();
const networkListeners = new Set();
for (const name of ['online', 'offline']) addEventListener(name, () => {
  for (const listener of networkListeners) listener({ isConnected: name === 'online' });
});
const trace = { metrics: { width, height, top, bottom }, frame: 0, texts: [], circles: [], clip: null,
  tasks: [], errors: [], loginCalls: 0, requestCalls: 0, socketCalls: 0, workersCreated: 0, activeWorkers: 0 };
const counterKey = storagePrefix + 'blocked-call-counts';
try {
  const saved = JSON.parse(sessionStorage.getItem(counterKey) || '{}');
  for (const key of ['loginCalls', 'requestCalls', 'socketCalls']) if (Number.isSafeInteger(saved[key]) && saved[key] >= 0) trace[key] = saved[key];
} catch (_) { /* A fresh test page still starts without any login. */ }
function blockedCall(key) {
  trace[key]++;
  sessionStorage.setItem(counterKey, JSON.stringify(Object.fromEntries(['loginCalls', 'requestCalls', 'socketCalls'].map(key => [key, trace[key]]))));
}
const boundedPush = (list, item) => { list.push(item); if (list.length > 500) list.shift(); };
const reportError = error => { trace.errors.push(String(error?.message || error)); status.textContent = `运行异常：${trace.errors.at(-1)}`; };
addEventListener('error', event => reportError(event.error || event.message));
addEventListener('unhandledrejection', event => reportError(event.reason));

// Some embedded browser surfaces defer animation frames even while reporting visible.
// This bounded browser-host fallback keeps state-driven drawing usable; it is never
// bundled for WeChat. Either the real frame or the timer invokes the callback once.
const browserFrame = globalThis.requestAnimationFrame.bind(globalThis);
const cancelBrowserFrame = globalThis.cancelAnimationFrame.bind(globalThis);
globalThis.requestAnimationFrame = callback => {
  let completed = false, timer;
  const id = browserFrame(time => {
    if (completed) return;
    completed = true; clearTimeout(timer); callback(time);
  });
  timer = setTimeout(() => {
    if (completed) return;
    completed = true; cancelBrowserFrame(id); callback(performance.now());
  }, 120);
  return id;
};

// Observe real draw calls, without replacing the canvas or exposing game internals.
const ctx = canvas.getContext('2d');
let currentCircle = null;
for (const name of ['beginPath', 'setTransform', 'fillText', 'arc', 'fill', 'stroke', 'rect', 'clip']) {
  const original = ctx[name].bind(ctx);
  ctx[name] = (...args) => {
    if (name === 'setTransform') {
      trace.frame++; trace.texts = []; trace.circles = []; trace.clip = null;
      if (!trace.errors.length) status.textContent = '已就绪 · 无需微信登录 · 存档只保留在本机';
    }
    if (name === 'beginPath') currentCircle = null;
    if (name === 'fillText') trace.texts.push({ text: String(args[0]), x: args[1], y: args[2], color: ctx.fillStyle, align: ctx.textAlign });
    if (name === 'arc') { currentCircle = { x: args[0], y: args[1], radius: args[2] }; trace.circles.push(currentCircle); }
    if (name === 'fill' && currentCircle) currentCircle.fill = ctx.fillStyle;
    if (name === 'stroke' && currentCircle) currentCircle.stroke = ctx.strokeStyle;
    if (name === 'rect') trace.pendingClip = { x: args[0], y: args[1], width: args[2], height: args[3] };
    if (name === 'clip') trace.clip = trace.pendingClip;
    return original(...args);
  };
}
const coordinate = event => {
  const bounds = canvas.getBoundingClientRect();
  return { clientX: (event.clientX - bounds.left) * width / bounds.width, clientY: (event.clientY - bounds.top) * height / bounds.height };
};
canvas.addEventListener('pointerdown', event => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  touches.set(event.pointerId, coordinate(event)); canvas.setPointerCapture(event.pointerId);
  events.touchStart?.({ touches: [...touches.values()] });
});
canvas.addEventListener('pointermove', event => {
  if (!touches.has(event.pointerId)) return;
  touches.set(event.pointerId, coordinate(event)); events.touchMove?.({ touches: [...touches.values()] });
});
canvas.addEventListener('pointerup', event => {
  if (!touches.delete(event.pointerId)) return;
  events.touchEnd?.({ touches: [...touches.values()], changedTouches: [coordinate(event)] });
});
for (const name of ['pointercancel', 'lostpointercapture']) canvas.addEventListener(name, event => {
  if (touches.delete(event.pointerId)) events.touchCancel?.({});
});
function lifecycle(hidden) {
  touches.clear();
  if (hidden) events.hide?.(); else events.show?.({});
}
document.addEventListener('visibilitychange', () => lifecycle(document.hidden));
addEventListener('resize', () => events.resize?.());
let simulatedHidden = false;
document.querySelector('#background').onclick = event => {
  simulatedHidden = !simulatedHidden; lifecycle(simulatedHidden);
  event.target.textContent = simulatedHidden ? '返回游戏' : '模拟切到后台';
};
document.querySelector('#reload').onclick = () => location.reload();

function showDialog(options, sheet = false) {
  const box = document.createElement('dialog'), heading = document.createElement('p');
  heading.textContent = sheet ? '请选择 / Choose' : options.content || options.title; box.append(heading);
  const input = options.editable ? document.createElement('input') : null;
  if (input) { input.placeholder = options.placeholderText || ''; input.setAttribute('aria-label', options.title); box.append(input); }
  const done = (confirm, index = -1) => {
    box.close(); box.remove();
    if (sheet) { if (confirm) options.success?.({ tapIndex: index }); else options.fail?.({ errMsg: 'cancel' }); }
    else options.success?.({ confirm, cancel: !confirm, content: input?.value || '' });
  };
  (sheet ? options.itemList : ['确定 / OK']).forEach((label, index) => {
    const button = document.createElement('button'); button.textContent = label;
    button.onclick = () => done(true, index); box.append(button);
  });
  if (sheet || options.showCancel !== false) {
    const cancel = document.createElement('button'); cancel.textContent = '取消 / Cancel'; cancel.onclick = () => done(false); box.append(cancel);
  }
  box.addEventListener('cancel', event => { event.preventDefault(); done(false); });
  document.body.append(box); box.showModal(); input?.focus();
}

globalThis.wx = {
  createCanvas: () => canvas,
  getWindowInfo: () => ({ windowWidth: width, windowHeight: height, pixelRatio: devicePixelRatio, safeArea: { top: 48, bottom: height - bottom } }),
  getMenuButtonBoundingClientRect: () => ({ bottom: top }),
  getStorageSync: key => localStorage.getItem(storagePrefix + key),
  setStorageSync: (key, value) => localStorage.setItem(storagePrefix + key, value),
  getClipboardData: options => navigator.clipboard.readText().then(data => options.success?.({ data }), () => options.fail?.({ errMsg: 'Clipboard unavailable' })),
  setClipboardData: options => navigator.clipboard.writeText(options.data).then(() => options.success?.({}), () => options.fail?.({ errMsg: 'Clipboard unavailable' })),
  onTouchStart: fn => { events.touchStart = fn; }, onTouchMove: fn => { events.touchMove = fn; },
  onTouchEnd: fn => { events.touchEnd = fn; }, onTouchCancel: fn => { events.touchCancel = fn; },
  onHide: fn => { events.hide = fn; }, onShow: fn => { events.show = fn; }, onWindowResize: fn => { events.resize = fn; },
  onNetworkStatusChange: fn => networkListeners.add(fn), offNetworkStatusChange: fn => networkListeners.delete(fn),
  showModal: options => showDialog(options), showActionSheet: options => showDialog(options, true),
  showShareMenu() {}, onShareAppMessage() {}, getLaunchOptionsSync: () => ({}),
  shareAppMessage: () => showDialog({ content: '分享需要微信客户端。免登录测试不会发送邀请。', showCancel: false }),
  login: options => { blockedCall('loginCalls'); options.fail?.({ errMsg: 'Offline host blocks login' }); },
  request: options => { blockedCall('requestCalls'); options.fail?.({ errMsg: 'Offline host blocks network' }); },
  connectSocket: () => { blockedCall('socketCalls'); throw new Error('Offline host blocks sockets'); },
  loadSubpackage: options => {
    // Local simulation only: the binary is fetched on readAsset below. Native
    // WeChat downloads the entire named package before invoking success.
    let progress;
    fetch('/dist/game.json').then(response => response.json()).then(game => {
      if (!game.subpackages.some(pack => pack.name === options.name)) throw new Error('Unknown model package');
      progress?.({ progress: 100 }); options.success?.({});
    }).catch(() => options.fail?.({}));
    return { onProgressUpdate: fn => { progress = fn; } };
  },
  getFileSystemManager: () => ({ readFile: options => {
    if (!/^models\/[a-z-]+\/[a-z0-9-]+\.bin$/.test(options.filePath)) { options.fail?.({}); return; }
    fetch(`/dist/${options.filePath}`).then(response => {
      if (!response.ok) throw new Error('Model unavailable'); return response.arrayBuffer();
    }).then(data => options.success?.({ data }), () => options.fail?.({}));
  } }),
  createWorker: entry => {
    if (entry !== 'workers/index.js') throw new Error('Unexpected Worker path');
    const worker = new Worker('/preview/worker.js'), pending = new Map();
    workers.add(worker); trace.workersCreated++; trace.activeWorkers = workers.size;
    worker.addEventListener('message', event => {
      const request = pending.get(event.data.id); pending.delete(event.data.id);
      const payload = request?.payload;
      boundedPush(trace.tasks, { kind: request?.kind, payload: payload && { ...payload,
        ...(payload.model ? { model: { id: payload.model.id, bytes: payload.model.raw?.byteLength } } : {}) }, response: event.data });
      if (event.data.ok && event.data.result?.snapshot) trace.lastState = event.data.result;
    });
    return {
      postMessage: message => { pending.set(message.id, message); worker.postMessage(message); },
      onMessage: fn => worker.addEventListener('message', event => fn(event.data)),
      onError: fn => worker.addEventListener('error', fn),
      terminate: () => { worker.terminate(); workers.delete(worker); trace.activeWorkers = workers.size; },
    };
  },
};
// Read-only observations for browser tests. No app/session reference or move shortcut.
globalThis.offlineProbe = { read: () => structuredClone(trace) };
const script = document.createElement('script'); script.src = '/dist/game.js';
script.onload = () => { if (!trace.errors.length && !trace.frame) status.textContent = '游戏已加载，正在绘制首屏…'; };
script.onerror = () => reportError('游戏包加载失败，请先构建。');
document.body.append(script);
