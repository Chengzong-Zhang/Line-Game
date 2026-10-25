/* Browser-only preview. No fake results: the compiled game Worker runs here. */
import { fixtureAdapter } from './online.js';
const canvas = document.getElementById('game');
const params = new URLSearchParams(location.search);
const width = Number(params.get('width')) || 390, height = Number(params.get('height')) || 844;
// Preserve the device aspect ratio when the desktop window is shorter.
canvas.style.width = `min(${width}px, 100vw, calc(100vh * ${width / height}))`;
canvas.style.height = 'auto'; canvas.style.aspectRatio = `${width} / ${height}`;
const coordinates = (event) => { const r = canvas.getBoundingClientRect(); return { clientX: (event.clientX - r.left) * width / r.width, clientY: (event.clientY - r.top) * height / r.height }; };
const activeTouches = new Map(), touchCallbacks = {};
canvas.addEventListener('pointerdown', event => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  activeTouches.set(event.pointerId, coordinates(event)); canvas.setPointerCapture(event.pointerId);
  touchCallbacks.start?.({ touches: [...activeTouches.values()] });
});
canvas.addEventListener('pointermove', event => {
  if (!activeTouches.has(event.pointerId)) return;
  activeTouches.set(event.pointerId, coordinates(event)); touchCallbacks.move?.({ touches: [...activeTouches.values()] });
});
canvas.addEventListener('pointerup', event => {
  if (!activeTouches.delete(event.pointerId)) return;
  touchCallbacks.end?.({ touches: [...activeTouches.values()], changedTouches: [coordinates(event)] });
});
for (const name of ['pointercancel', 'lostpointercapture']) canvas.addEventListener(name, event => {
  if (activeTouches.delete(event.pointerId)) touchCallbacks.cancel?.({});
});
document.addEventListener('visibilitychange', () => { if (document.hidden) activeTouches.clear(); });
// In-app browsers may not support window.prompt. These preview-only controls
// exercise the same callbacks as native wx modals and action sheets.
function dialog(title, { items, input = false, cancel = true } = {}) {
  return new Promise(resolve => {
    const box = document.createElement('dialog'), heading = document.createElement('p');
    heading.textContent = title; box.append(heading);
    const field = input ? document.createElement('input') : null;
    if (field) { field.setAttribute('aria-label', title); box.append(field); }
    const done = value => { box.close(); box.remove(); resolve(value); };
    (items || ['OK']).forEach((item, i) => {
      const button = document.createElement('button'); button.textContent = item;
      button.onclick = () => done(items ? i : field ? field.value : true); box.append(button);
    });
    if (cancel) { const button = document.createElement('button'); button.textContent = '取消 / Cancel'; button.onclick = () => done(items ? -1 : null); box.append(button); }
    box.addEventListener('cancel', event => { event.preventDefault(); done(items ? -1 : null); });
    document.body.append(box); box.showModal(); field?.focus();
  });
}
const platform = {
  canvas, metrics: () => ({ width, height, dpr: Math.min(devicePixelRatio, 2), top: 28, bottom: 24 }),
  storage: { get: (key) => localStorage.getItem(key), set: (key, value) => localStorage.setItem(key, value) },
  readClipboard: async () => {
    try { return await navigator.clipboard.readText(); } catch (_) { throw new Error('CLIPBOARD_UNAVAILABLE'); }
  },
  writeClipboard: async text => {
    try { await navigator.clipboard.writeText(text); } catch (_) { throw new Error('CLIPBOARD_UNAVAILABLE'); }
  },
  createWorker: () => {
    const worker = new Worker('/preview/worker.js');
    return { postMessage: (data) => worker.postMessage(data), onMessage: (fn) => worker.addEventListener('message', (e) => fn(e.data)),
      onError: (fn) => worker.addEventListener('error', fn), terminate: () => worker.terminate() };
  },
  loadSubpackage: async (name, progress) => {
    const game = await fetch('/dist/game.json').then(response => response.json());
    if (!game.subpackages.some(pack => pack.name === name)) throw new Error('MODEL_DOWNLOAD_FAILED');
    progress?.(100);
  },
  readAsset: async filePath => {
    if (!/^models\/[a-z-]+\/[a-z0-9-]+\.bin$/.test(filePath)) throw new Error('MODEL_READ_FAILED');
    const response = await fetch(`/dist/${filePath}`);
    if (!response.ok) throw new Error('MODEL_READ_FAILED'); return response.arrayBuffer();
  },
  frame: (fn) => requestAnimationFrame(fn),
  touchStart: fn => { touchCallbacks.start = fn; }, touchEnd: fn => { touchCallbacks.end = fn; },
  touchMove: fn => { touchCallbacks.move = fn; }, touchCancel: fn => { touchCallbacks.cancel = fn; },
  onHide: (fn) => document.addEventListener('visibilitychange', () => document.hidden && fn()),
  onShow: (fn) => document.addEventListener('visibilitychange', () => !document.hidden && fn({})),
  onResize: (fn) => window.addEventListener('resize', fn),
  confirm: async (content) => Boolean(await dialog(content)), message: async (content) => dialog(content, { cancel: false }),
  choose: items => dialog('请选择 / Choose', { items }),
  input: title => dialog(title, { input: true }), setupShare: () => {}, launchOptions: () => ({}),
  share: () => dialog('分享需要微信客户端。', { cancel: false }),
};
const runtime = await fetch('/preview/runtime.json').then(response => response.json());
const config = { workerTimeoutMs: 15000 };
if (runtime.onlineFixture) {
  const player = params.get('player') || 'blue';
  Object.assign(platform, fixtureAdapter(player, params, dialog));
  Object.assign(config, { onlineEnabled: true, apiBase: 'https://preview.invalid' });
  const notice = document.getElementById('notice');
  notice.textContent = `本机联机测试 · 测试身份 ${player}。棋子颜色由房间分配。模拟微信登录，真实本机 HTTP/WS。不是微信验收。`;
  notice.dataset.fixture = 'true';
}
window.previewApp = Lifeline.createApp(platform, config);
