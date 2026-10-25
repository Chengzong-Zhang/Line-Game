import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_CATALOG } from '../src/model-catalog.js';

export const gameRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = new Map([
  ['/', 'preview/offline.html'], ['/preview/offline-host.js', 'preview/offline-host.js'],
  ['/preview/worker.js', 'preview/worker.js'], ['/dist/game.js', 'dist/game.js'],
  ['/dist/workers/index.js', 'dist/workers/index.js'],
  ['/dist/game.json', 'dist/game.json'],
  ...MODEL_CATALOG.map(model => [`/dist/${model.assetPath}`, `dist/${model.assetPath}`]),
]);
export async function startOfflineServer({ port = 0 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  let origin;
  const server = createServer(async (request, response) => {
    const deny = code => { response.writeHead(code); response.end('Local test only'); };
    try {
      if (request.headers.host !== new URL(origin).host || request.headers.origin && request.headers.origin !== origin
        || request.headers['sec-fetch-site'] === 'cross-site') return deny(403);
      if (request.method !== 'GET') return deny(405);
      if (!request.url.startsWith('/') || request.url.startsWith('//')) return deny(404);
      const url = new URL(request.url, origin);
      if (url.origin !== origin) return deny(404);
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
      if (url.pathname === '/health') {
        response.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ kind: 'lifeline-offline-host', login: false, network: false })); return;
      }
      const name = files.get(url.pathname);
      if (!name) return deny(404);
      const content = await fs.readFile(path.join(gameRoot, name));
      response.writeHead(200, { ...headers, 'Content-Type': name.endsWith('.html') ? 'text/html; charset=utf-8'
        : name.endsWith('.json') ? 'application/json' : name.endsWith('.bin') ? 'application/octet-stream' : 'text/javascript; charset=utf-8' });
      response.end(content);
    } catch (_) { if (!response.headersSent) deny(500); else response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = await startOfflineServer({ port: Number(process.env.LIFELINE_OFFLINE_PORT || 8793) });
  console.log(`OFFLINE_PREVIEW=${host.origin}/`);
  console.log('No login, no external service. Ctrl+C stops this local preview.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await host.close(); process.exit(0); });
}
