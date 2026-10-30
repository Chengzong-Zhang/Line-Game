import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

// Serve the frozen release on loopback, with real module Workers and model fetches.
// This is browser functionality evidence, not a model-strength or WeChat-device test.
const root = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
const manifest = JSON.parse(await fs.readFile(path.join(root, 'release-manifest.json'), 'utf8'));
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/__probe') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Worker probe</title>'); return; }
    const file = path.resolve(root, `.${pathname}`), relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('OUTSIDE_RELEASE');
    response.setHeader('Content-Type', /\.(m?js)$/.test(file) ? 'text/javascript' : 'application/octet-stream');
    response.end(await fs.readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/__probe`);
  const rows = await page.evaluate(async version => {
    const { GameEngine } = await import(`/GameEngine.js?v=${version}`);
    const { localAIWorkerRoute } = await import(`/LocalAIWorkerFactory.js?v=${version}`);
    const { serializeEngineState, captureWorkerRequest, isWorkerResultForRequest } = await import(`/AIStateProtocol.js?v=${version}`);
    const rows = [];
    for (const ordered of [false, true]) {
      const turnOrder = ['PURPLE', 'BLACK', 'GREEN', 'WHITE'];
      const game = new GameEngine({ playerCount: 4, gridSize: 5, rulesVersion: 'territory-v3',
        ...(ordered ? { startPlayer: turnOrder[0], turnOrder } : {}) });
      const route = localAIWorkerRoute(game, [{ strategy: 'multiplayer', modelId: 'multiplayer-hard-v1' }]);
      const worker = new Worker(route.url, { type: 'module' }), messages = [], requestId = `browser-${ordered}`;
      const request = captureWorkerRequest(game, requestId);
      let timer;
      try {
        const result = await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(Error('WORKER_TIMEOUT')), 20000);
          worker.onerror = event => reject(Error(event.message));
          worker.onmessage = ({ data }) => { messages.push(data); if (data.type === 'RESULT') resolve(data); else if (data.type === 'ERROR') reject(Error(data.message)); };
          worker.postMessage({ type: 'COMPUTE', strategy: 'multiplayer', modelId: 'multiplayer-hard-v1', requestId,
            serializedState: serializeEngineState(game), aiPlayer: game.currentPlayer, topN: 2, enableProgress: true, timeLimitMs: 3000 });
        });
        const move = result.moves[0];
        rows.push({ ordered, kind: route.kind, entry: route.url.pathname, ready: messages.some(m => m.type === 'READY'),
          progress: messages.some(m => m.type === 'PROGRESS'), accepted: isWorkerResultForRequest(game, request, result),
          legal: move?.type === 'pass' || game._evaluateMove(move.point).legal, implementationId: result.modelInfo.implementationId });
      } finally { clearTimeout(timer); worker.terminate(); }
    }
    return rows;
  }, manifest.asset_version);
  assert.equal(rows[0].kind, 'native-hard-bundle');
  assert.equal(rows[1].kind, 'native-hard-source-turn-order');
  assert.ok(rows.every(row => row.ready && row.progress && row.accepted && row.legal));
  assert.deepEqual(errors, []);
  const receipt = { status: 'PASS_REAL_BROWSER_RELEASE_WORKERS', releaseId: manifest.release_id, browser: await browser.version(),
    scope: 'frozen release served on loopback; actual module Workers and model HTTP fetches', deviceVerified: false, strengthAdmission: false, rows, errors };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
