import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '');
const expectOnline = process.env.LIFELINE_TEST_ONLINE === '1';
assert.ok(process.argv[2], 'Pass the isolated itch candidate root.');
const dist = path.join(root, 'local_artifacts/itch-html5/dist');
const { chromium } = createRequire(path.join(root, 'itch/package.json'))('playwright-core');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8' };
const server = createServer(async (request, response) => {
  try {
    const uri = new URL(request.url, 'http://localhost').pathname;
    if (uri === '/') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<iframe title="LIFELINE" src="/candidate/" sandbox="allow-scripts allow-same-origin allow-downloads allow-forms allow-pointer-lock" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>'); return; }
    if (!uri.startsWith('/candidate/')) throw new Error('not found');
    const relative = decodeURIComponent(uri.slice('/candidate/'.length)) || 'index.html';
    const target = path.resolve(dist, relative);
    if (target !== dist && !target.startsWith(`${dist}${path.sep}`)) throw new Error('invalid path');
    const body = await readFile(target);
    response.writeHead(200, { 'content-type': types[path.extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' }); response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(online => {
    if (!location.pathname.startsWith('/candidate/')) return;
    const consent = { policy: 'anonymous-replay-training-v3', enabled: true, queue: [{ marker: 'preserve' }] };
    localStorage.setItem('lifeline-training-contribution-v1', JSON.stringify(consent));
    if (!online) {
      localStorage.setItem('triaxis-auth', JSON.stringify({ username: 'synthetic', token: 'synthetic' }));
      localStorage.setItem('triaxis-online-session', JSON.stringify({ url: 'wss://example.invalid/ws', roomId: 'ABCD', playerId: 'synthetic', color: 'BLACK' }));
    }
  }, expectOnline);
  const page = await context.newPage();
  const errors = [], external = [], failed = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(base)) external.push(request.url()); });
  page.on('websocket', socket => external.push(socket.url()));
  page.on('response', response => { if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`); });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: '跳过教学', exact: true }).click({ timeout: 30000 });
  await frame.getByRole('button', { name: '棋盘舱', exact: true }).waitFor();
  assert.equal(await frame.getByRole('button', { name: '联机舱', exact: true }).count(), expectOnline ? 1 : 0);
  const runtime = page.frames().find(item => item.url().startsWith(`${base}/candidate/`));
  const check = await runtime.evaluate(async () => {
    const state = document.querySelector('#app')._vnode.component.proxy.contributionState;
    const saved = JSON.parse(localStorage.getItem('lifeline-training-contribution-v1'));
    const image = await fetch('./guide/guide-images/三点限制.png');
    const worker = await new Promise((resolve, reject) => {
      const instance = new Worker('./frozen-workers/web-topology-fix-20261030-r2/MultiplayerHardAIWorker.bundle.mjs', { type: 'module' });
      instance.onerror = event => { instance.terminate(); reject(new Error(event.message || 'Worker failed')); };
      setTimeout(() => { instance.terminate(); resolve(true); }, 1000);
    });
    return { enabled: state.enabled, savedEnabled: saved.enabled, savedQueue: saved.queue, imageStatus: image.status, worker,
      serverUrl: document.querySelector('#app')._vnode.component.proxy.serverUrl };
  });
  assert.equal(check.enabled, false); assert.equal(check.savedEnabled, true); assert.deepEqual(check.savedQueue, [{ marker: 'preserve' }]);
  if (expectOnline) assert.equal(check.serverUrl, 'wss://example.invalid/ws');
  assert.equal(check.imageStatus, 200); assert.equal(check.worker, true);
  await frame.getByRole('button', { name: '指南舱', exact: true }).click();
  await page.waitForTimeout(500);
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(failed, []);
  console.log(JSON.stringify({ status: 'PASS_ITCH_IFRAME_SMOKE', legacyQueuePreserved: true, networkMode: expectOnline ? 'configured-online' : 'offline', chineseImage: 200, frozenWorkerLoads: true, errors, external, failed }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
